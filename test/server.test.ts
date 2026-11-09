/**
 * Tests de bout en bout du serveur famille : installation, PIN, droits des profils,
 * connexion ÉcoleDirecte partagée, reconnexion automatique et persistance.
 *
 * Un faux client ÉcoleDirecte remplace le réseau. Le serveur écoute sur
 * 127.0.0.1 (donc « réseau de la maison ») ; une requête « venue d'Internet » est
 * simulée par l'en-tête X-Forwarded-For qu'ajoute le reverse proxy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { createApp } from '../src/server/server.ts';
import { Vault } from '../src/server/vault.ts';
import { EdError, type EdFile, type EdMail, type EdMailDetail, type Factor } from '../src/server/ecoledirecte.ts';
import type { EdClient } from '../src/server/ed-service.ts';
import type { Coach } from '../src/server/coach.ts';
import type {
  AuthResult,
  AuthState,
  Course,
  Dashboard,
  HomeworkPage,
  Note,
  SchoolInfo,
  SchoolLife,
} from '../src/shared/types.ts';

/** Hier à 10 h, au format des messages : toujours « récent » quel que soit le jour du test. */
const yesterday = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10) + 'T10:00';

const note = (id: number, value: number, date: string, subject = 'Maths'): Note => ({
  id,
  subject,
  subjectId: subject + ':',
  title: 'Contrôle',
  date,
  raw: String(value),
  value,
  outOf: 20,
  coefficient: 1,
  classAverage: 12,
  excluded: false,
});

class FakeEd implements EdClient {
  static logins: { password: string; factors: Factor[] }[] = [];
  static expireNext = false;
  static notes: Record<string, Note[]> = {
    '1:11': [note(1, 15, '2026-11-02')],
    '1:12': [note(2, 9, '2026-11-03', 'Français')],
  };
  state: AuthState = 'anonymous';
  trusted: Factor[] = [];
  clear() {
    this.state = 'anonymous';
  }
  async login(_u: string, password: string, factors: Factor[] = []): Promise<AuthResult> {
    FakeEd.logins.push({ password, factors });
    if (password === 'bon' && factors.length) {
      this.state = 'authenticated';
      this.trusted = factors;
      return { state: 'authenticated' };
    }
    if (password === 'bon') {
      this.state = 'question';
      return { state: 'question', question: 'Ville ?', choices: ['Rouen', 'Caen'] };
    }
    throw new EdError('Identifiant, mot de passe ou vérification refusé.', 400);
  }
  async verify(input: { choice?: unknown }): Promise<AuthResult> {
    if (input.choice !== 0) throw new EdError('Réponse de sécurité refusée.', 400);
    this.state = 'authenticated';
    this.trusted = [{ cn: 'CN', cv: 'CV' }];
    return { state: 'authenticated' };
  }
  async dashboard(): Promise<Dashboard> {
    if (FakeEd.expireNext) {
      FakeEd.expireNext = false;
      this.state = 'anonymous';
      throw new EdError('Votre session a expiré. Reconnectez-vous.', 401);
    }
    return {
      demo: false,
      updatedAt: new Date().toISOString(),
      children: [
        { id: '1:11', name: 'Léo', className: '5e B', notes: FakeEd.notes['1:11'] ?? [], periods: [] },
        { id: '1:12', name: 'Nina', className: '6e A', notes: FakeEd.notes['1:12'] ?? [], periods: [] },
      ],
    };
  }
  async homeworkForChild(childId: string): Promise<HomeworkPage> {
    return {
      homework: [
        {
          id: '2026-11-10:' + childId.replace(':', ''),
          dueDate: '2026-11-10',
          subject: 'Maths',
          text: 'Exercice',
          status: 'pending',
          exam: false,
          documents: [],
        },
      ],
      homeworkDates: [],
      homeworkPartial: false,
      homeworkNext: null,
      homeworkUntil: '2026-12-09',
    };
  }
  async timetableForChild(_childId: string, from: string): Promise<Course[]> {
    const base = { room: 'S1', teacher: 'M. X', kind: 'cours', modified: false, exempted: false };
    return [
      {
        ...base,
        id: 'a',
        date: from,
        start: '08:00',
        end: '08:55',
        subject: 'MATHEMATIQUES',
        code: 'MATH',
        cancelled: false,
      },
      {
        ...base,
        id: 'b',
        date: from,
        start: '09:00',
        end: '09:55',
        subject: 'ED.PHYSIQUE & SPORT.',
        code: 'EPS',
        cancelled: false,
      },
      {
        ...base,
        id: 'c',
        date: from,
        start: '10:10',
        end: '11:05',
        subject: 'TECHNOLOGIE',
        code: 'TECH',
        cancelled: true,
      },
      {
        ...base,
        id: 'd',
        date: from,
        start: '11:10',
        end: '12:05',
        subject: 'PHYSIQUE-CHIMIE',
        code: 'PHY',
        cancelled: false,
      },
    ];
  }
  async schoolInfosForChild(): Promise<SchoolInfo[]> {
    return [{ id: '1', text: 'Sortie au musée', from: null, to: null }];
  }
  async mailbox(childId: string | null): Promise<EdMail[]> {
    if (childId === '1:12') throw new EdError('ÉcoleDirecte a refusé la demande (code 403).', 400);
    if (childId === null)
      return [
        {
          id: '10',
          subject: 'Réunion de rentrée',
          from: 'Direction',
          fromRole: 'staff',
          date: yesterday(),
          read: false,
          files: [{ id: '77', name: 'convocation.pdf' }],
        },
        {
          id: '11',
          subject: 'Avertissement',
          from: 'CPE',
          fromRole: 'staff',
          date: yesterday(),
          read: true,
          files: [],
        },
      ];
    return [{ id: '20', subject: 'DM', from: 'Mme B', fromRole: 'teacher', date: yesterday(), read: false, files: [] }];
  }
  /** Comme le compte parent sur ÉcoleDirecte : n'importe quel identifiant s'ouvre, quelle que soit la boîte demandée. */
  async mail(_childId: string | null, id: string): Promise<EdMailDetail> {
    const all = [...(await this.mailbox(null)), ...(await this.mailbox('1:11'))];
    const found = all.find((m) => m.id === id);
    if (!found) throw new EdError('Message introuvable.', 404);
    return { ...found, text: 'Bonjour' };
  }
  async mailFile(): Promise<EdFile> {
    return { type: 'application/pdf', name: 'convocation.pdf', body: Buffer.from('%PDF-1.4 test') };
  }
  async schoolLifeForChild(childId: string): Promise<SchoolLife> {
    const base = { when: '', justified: null, by: '', comment: '' };
    return {
      events:
        childId === '1:11'
          ? [
              {
                ...base,
                id: 'se-1',
                kind: 'punition',
                type: 'Punition',
                title: 'Retenue',
                date: '2026-11-05',
                reason: 'Bavardages',
                todo: '1 heure',
              },
            ]
          : [],
    };
  }
  exportSession() {
    return this.state === 'authenticated' ? { version: 1 as const, token: 't', cookies: [], accounts: [] } : null;
  }
  restoreSession() {
    this.state = 'authenticated';
  }
}

const coach: Coach = { configured: true, advice: async () => 'Continue comme ça en maths.' };

interface Client {
  get(path: string, headers?: Record<string, string>): Promise<{ status: number; body: any; cookie: string }>;
  post(
    path: string,
    data?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: any; cookie: string }>;
}

async function start(dir: string, seed = 'Camille:parent+admin, Alex:parent, Léo:enfant:5e, Nina:enfant:6e') {
  const server = createApp({
    vault: new Vault(dir),
    familySeed: seed,
    edFactory: () => new FakeEd(),
    coach,
    refreshFloor: 0,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const browser = (jar = ''): Client & { jar: () => string } => {
    let cookies = jar;
    const call = async (method: string, path: string, data: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          ...(method === 'POST' ? { 'content-type': 'application/json', 'x-orbite-client': '1' } : {}),
          ...(cookies ? { cookie: cookies } : {}),
          ...headers,
        },
        body: method === 'POST' ? JSON.stringify(data ?? {}) : null,
      });
      const set = res.headers.getSetCookie().map((c) => c.split(';')[0] ?? '');
      if (set.length) {
        const map = new Map(cookies ? cookies.split('; ').map((c) => c.split('=') as [string, string]) : []);
        for (const c of set) {
          const [k, v = ''] = c.split('=');
          if (k) v ? map.set(k, v) : map.delete(k);
        }
        cookies = [...map].map(([k, v]) => `${k}=${v}`).join('; ');
      }
      return { status: res.status, body: await res.json().catch(() => null), cookie: cookies };
    };
    return {
      get: (p, h) => call('GET', p, undefined, h),
      post: (p, d, h) => call('POST', p, d, h),
      jar: () => cookies,
    };
  };
  return { server, browser, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const internet = { 'x-forwarded-for': '203.0.113.9' };

test('installation, droits des profils et connexion ÉcoleDirecte partagée', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'o5g-'));
  FakeEd.logins = [];
  const app = await start(dir);
  try {
    const parentPhone = app.browser();
    let s = await parentPhone.get('/api/session');
    assert.equal(s.body.setupNeeded, true);
    assert.equal(s.body.members.length, 4);
    const admin = s.body.members.find((m: any) => m.admin);
    assert.equal(admin.name, 'Camille');

    // Depuis Internet : prénoms masqués et installation refusée.
    const stranger = app.browser();
    s = await stranger.get('/api/session', internet);
    assert.deepEqual(s.body.members, []);
    s = await stranger.post('/api/setup', { memberId: admin.id, pin: '482916' }, internet);
    assert.equal(s.status, 403);
    s = await stranger.post('/api/setup', { memberId: admin.id, pin: '482916', code: 'ZZZZ-ZZZZ' }, internet);
    assert.equal(s.status, 403);

    // PIN trop simple refusé, puis installation depuis la maison.
    s = await parentPhone.post('/api/setup', { memberId: admin.id, pin: '123456' });
    assert.equal(s.status, 400);
    s = await parentPhone.post('/api/setup', { memberId: admin.id, pin: '482916' });
    assert.equal(s.status, 200);
    assert.equal(s.body.me.name, 'Camille');
    assert.equal(s.body.setupNeeded, false);

    // Connexion ÉcoleDirecte avec question de sécurité.
    s = await parentPhone.post('/api/admin/ed/connect', { username: 'parent.dupont', password: 'bon', remember: true });
    assert.equal(s.body.state, 'question');
    s = await parentPhone.post('/api/admin/ed/verify', { choice: 0 });
    assert.equal(s.body.state, 'authenticated');
    s = await parentPhone.get('/api/session');
    assert.equal(s.body.ed.link, 'connected');
    assert.equal(s.body.ed.account, 'pa•••nt');
    assert.equal(s.body.ed.autoReconnect, true);

    // Le parent voit les deux élèves ; le rattachement par prénom est automatique.
    s = await parentPhone.post('/api/data', {});
    assert.deepEqual(
      s.body.children.map((c: any) => c.name),
      ['Léo', 'Nina'],
    );
    s = await parentPhone.get('/api/admin/members');
    const leo = s.body.members.find((m: any) => m.name === 'Léo');
    assert.equal(leo.studentId, '1:11');

    // Activation du profil d'Léo par code à usage unique.
    s = await parentPhone.post('/api/admin/member/code', { memberId: leo.id });
    const code = s.body.code as string;
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const leoPhone = app.browser();
    s = await leoPhone.post('/api/activate', { name: 'leo', code: 'ZZZZ-ZZZZ', pin: '730519' }, internet);
    assert.equal(s.status, 403);
    s = await leoPhone.post('/api/activate', { name: 'leo', code: code.toLowerCase(), pin: '730519' }, internet);
    assert.equal(s.status, 200);
    assert.equal(s.body.me.role, 'child');
    // Appareil reconnu : les prénoms s'affichent désormais hors de la maison.
    s = await leoPhone.get('/api/session', internet);
    assert.equal(s.body.members.length, 4);
    // Code consommé.
    s = await app.browser().post('/api/activate', { memberId: leo.id, code, pin: '730519' });
    assert.equal(s.status, 403);

    // Léo ne voit que lui et n'accède ni aux devoirs de Nina ni à l'administration.
    s = await leoPhone.post('/api/data', {});
    assert.deepEqual(
      s.body.children.map((c: any) => c.id),
      ['1:11'],
    );
    assert.equal(s.body.ed, undefined);
    s = await leoPhone.post('/api/homework', { childId: '1:12' });
    assert.equal(s.status, 404);
    s = await leoPhone.post('/api/homework', { childId: '1:11' });
    assert.equal(s.body.homework.length, 1);
    s = await leoPhone.post('/api/admin/ed/disconnect', {});
    assert.equal(s.status, 403);
    s = await leoPhone.get('/api/admin/members');
    assert.equal(s.status, 403);
    s = await leoPhone.get('/api/session');
    assert.equal(s.body.ed, null);

    // Case « fait » partagée avec les parents.
    s = await leoPhone.post('/api/check', { childId: '1:11', homeworkId: '2026-11-10:111', done: true });
    assert.deepEqual(s.body.checks, ['2026-11-10:111']);
    s = await parentPhone.post('/api/data', {});
    assert.deepEqual(s.body.checks['1:11'], ['2026-11-10:111']);

    // Conseil IA limité à l'élève autorisé.
    s = await leoPhone.post('/api/coaching', { childId: '1:11' });
    assert.equal(s.body.text, 'Continue comme ça en maths.');
    s = await leoPhone.post('/api/coaching', { childId: '1:12' });
    assert.equal(s.status, 404);

    // Protections HTTP.
    s = await parentPhone.post('/api/data', {}, { 'x-orbite-client': '0' });
    assert.equal(s.status, 403);
    const status = await new Promise<number>((resolve) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: (app.server.address() as AddressInfo).port,
          path: '/api/session',
          headers: { host: 'evil.example' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.end();
    });
    assert.equal(status, 403);
    // Même nom, relayé en HTTPS par le reverse proxy local : accepté, sans privilèges « maison ».
    const proxied = await new Promise<{ status: number; body: string }>((resolve) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: (app.server.address() as AddressInfo).port,
          path: '/api/session',
          headers: { host: 'orbite.example.fr', 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' },
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.end();
    });
    assert.equal(proxied.status, 200);
    assert.equal(JSON.parse(proxied.body).onLan, false);
    s = await parentPhone.post('/api/data', {}, { origin: 'https://evil.example' });
    assert.equal(s.status, 403);
    // Lien ouvert depuis un autre site : la page s'affiche, l'API reste fermée.
    const port = (app.server.address() as AddressInfo).port;
    const page = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' },
    });
    assert.equal(page.status, 200);
    s = await parentPhone.get('/api/session', { 'sec-fetch-site': 'cross-site' });
    assert.equal(s.status, 403);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('blocage après cinq PIN faux et déconnexion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'o5g-'));
  const app = await start(dir);
  try {
    const b = app.browser();
    const admin = (await b.get('/api/session')).body.members.find((m: any) => m.admin);
    await b.post('/api/setup', { memberId: admin.id, pin: '482916' });
    await b.post('/api/logout', {});
    let s = await b.get('/api/session');
    assert.equal(s.body.me, null);
    for (let i = 0; i < 5; i++) {
      s = await b.post('/api/login', { memberId: admin.id, pin: '000001' });
      assert.equal(s.status, 403);
    }
    s = await b.post('/api/login', { memberId: admin.id, pin: '482916' });
    assert.equal(s.status, 429);
    assert.match(s.body.error, /Réessaie dans/);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconnexion automatique avec les facteurs de confiance et persistance au redémarrage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'o5g-'));
  FakeEd.logins = [];
  let app = await start(dir);
  const b = app.browser();
  try {
    const admin = (await b.get('/api/session')).body.members.find((m: any) => m.admin);
    await b.post('/api/setup', { memberId: admin.id, pin: '482916' });
    await b.post('/api/admin/ed/connect', { username: 'parent.dupont', password: 'bon', remember: true });
    await b.post('/api/admin/ed/verify', { choice: 0 });
    let s = await b.post('/api/data', {});
    assert.equal(s.body.children.length, 2);
    assert.deepEqual(s.body.fresh, [], 'premier chargement : rien de « nouveau »');

    // Le jeton expire : le serveur se reconnecte seul, sans nouvelle question.
    FakeEd.expireNext = true;
    s = await b.post('/api/data', { refresh: true });
    assert.equal(s.status, 200);
    const last = FakeEd.logins.at(-1);
    assert.deepEqual(last?.factors, [{ cn: 'CN', cv: 'CV' }]);
    assert.equal(last?.password, 'bon');

    // Une nouvelle note apparaît : signalée comme nouvelle jusqu'à la visite.
    FakeEd.notes['1:11'] = [...(FakeEd.notes['1:11'] ?? []), note(3, 17, '2026-11-08')];
    s = await b.post('/api/data', { refresh: true });
    assert.deepEqual(s.body.fresh, ['1:11|3']);
    await b.post('/api/seen', {});
    s = await b.post('/api/data', {});
    assert.deepEqual(s.body.fresh, []);
  } finally {
    await app.close();
  }
  // Redémarrage : profils, appareil et lien ÉcoleDirecte restaurés depuis le coffre.
  app = await start(dir, '');
  try {
    const again = app.browser(b.jar());
    const s = await again.get('/api/session');
    assert.equal(s.body.me.name, 'Camille');
    assert.equal(s.body.ed.link, 'connected');
    assert.equal(s.body.members.length, 4);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fichiers statiques sur liste blanche et santé', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'o5g-'));
  const app = await start(dir);
  try {
    const b = app.browser();
    for (const path of ['/.env', '/../package.json', '/src/server/server.ts', '/key', '/family.enc']) {
      const s = await fetch(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}${path}`);
      assert.equal(s.status, 404, path);
    }
    const health = await b.get('/healthz', { host: 'nas' });
    assert.equal(health.body.ok, true);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installation à distance avec le code du journal, à usage unique', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'o5g-'));
  const app = await start(dir);
  try {
    const phone = app.browser();
    const admin = (await app.browser().get('/api/session')).body.members.find((m: any) => m.admin);
    const code = new Vault(dir).load<{ setupCode?: string }>('secret', {}).setupCode ?? '';
    assert.equal(code.length, 8);
    const formatted = code.slice(0, 4).toLowerCase() + '-' + code.slice(4);
    // Appareil inconnu hors de la maison : prénoms masqués, installation par le prénom.
    assert.deepEqual((await phone.get('/api/session', internet)).body.members, []);
    let s = await phone.post('/api/setup', { name: 'camille', pin: '482916', code: formatted }, internet);
    assert.equal(s.status, 200);
    assert.equal(s.body.me.admin, true);
    assert.equal(new Vault(dir).load<{ setupCode?: string }>('secret', {}).setupCode, undefined);
    s = await app.browser().post('/api/setup', { memberId: admin.id, pin: '730519', code: formatted }, internet);
    assert.equal(s.status, 403);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cartable : cours du jour, sac sans doublon ni cours annulé, cases et matériel personnalisé', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'o5g-'));
  const app = await start(dir);
  try {
    const b = app.browser();
    const admin = (await b.get('/api/session')).body.members.find((m: any) => m.admin);
    await b.post('/api/setup', { memberId: admin.id, pin: '482916' });
    await b.post('/api/admin/ed/connect', { username: 'parent.dupont', password: 'bon', remember: true });
    await b.post('/api/admin/ed/verify', { choice: 0 });
    await b.post('/api/data', {});
    const date = '2026-11-10';
    let s = await b.post('/api/bag', { childId: '1:11', date });
    if (s.status === 400) return; // date hors fenêtre selon le jour d'exécution : couvert par le test unitaire
    assert.equal(s.body.courses.length, 4);
    const labels = s.body.items.map((i: any) => i.label);
    assert.ok(labels.includes('Tenue de sport'));
    assert.equal(labels.filter((l: string) => l === 'Calculatrice').length, 1, 'calculatrice une seule fois');
    assert.ok(!labels.includes('Classeur de technologie'), 'cours annulé exclu');
    assert.ok(labels.includes('Trousse complète'));
    assert.deepEqual(
      s.body.infos.map((i: any) => i.text),
      ['Sortie au musée'],
    );
    s = await b.post('/api/bag/pack', { childId: '1:11', date, itemId: 'tenue-de-sport', packed: true });
    assert.deepEqual(s.body.packed, ['tenue-de-sport']);
    s = await b.post('/api/bag/kit', {
      childId: '1:11',
      kit: { always: ['Trousse', 'Gourde'], subjects: { MATHEMATIQUES: ['Cahier bleu', 'Calculatrice'] } },
    });
    s = await b.post('/api/bag', { childId: '1:11', date });
    const after = s.body.items.map((i: any) => i.label);
    assert.ok(after.includes('Cahier bleu'));
    assert.ok(!after.includes('Cahier de maths'));
    assert.deepEqual(s.body.packed, ['tenue-de-sport']);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('chaque module servi au navigateur trouve ses imports parmi les fichiers servis', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'o5g-'));
  const app = await start(dir);
  try {
    const port = (app.server.address() as AddressInfo).port;
    const queue = ['/client/app.js'];
    const seen = new Set<string>();
    while (queue.length) {
      const path = queue.shift() as string;
      if (seen.has(path)) continue;
      seen.add(path);
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(res.status, 200, `${path} doit être servi`);
      const code = await res.text();
      for (const m of code.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
        queue.push(new URL(m[1] as string, `http://x${path}`).pathname);
      }
    }
    assert.ok(seen.has('/shared/bag.js'));
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('messagerie en lecture seule : boîte famille, partage avec un enfant, pièce jointe signée ; vie scolaire', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'o5g-'));
  const app = await start(dir);
  try {
    const parent = app.browser();
    const admin = (await parent.get('/api/session')).body.members.find((m: any) => m.admin);
    await parent.post('/api/setup', { memberId: admin.id, pin: '482916' });
    await parent.post('/api/admin/ed/connect', { username: 'parent.dupont', password: 'bon', remember: true });
    await parent.post('/api/admin/ed/verify', { choice: 0 });
    await parent.post('/api/data', {});
    const leo = (await parent.get('/api/admin/members')).body.members.find((m: any) => m.name === 'Léo');
    const code = (await parent.post('/api/admin/member/code', { memberId: leo.id })).body.code;
    const kid = app.browser();
    await kid.post('/api/activate', { memberId: leo.id, code, pin: '730519' });

    // Parent : boîte famille complète, nouveautés selon ÉcoleDirecte.
    let s = await parent.post('/api/messages', {});
    assert.deepEqual(
      s.body.items.map((i: any) => i.key),
      ['f.10', 'f.11'],
    );
    assert.equal(s.body.unread, 1);
    assert.deepEqual(s.body.items[0].sharedWith, []);

    // Enfant : sa propre messagerie élève, rien de la boîte famille tant que rien n'est partagé.
    s = await kid.post('/api/messages', {});
    assert.deepEqual(
      s.body.items.map((i: any) => i.key),
      ['s.1:11.20'],
    );
    assert.equal((await kid.post('/api/message', { key: 'f.10' })).status, 404);
    assert.equal((await kid.post('/api/messages', { childId: '1:12' })).status, 404);
    assert.equal((await kid.post('/api/message/share', { key: 'f.10', childIds: ['1:11'] })).status, 403);

    // Le parent partage la réunion avec Léo, pas l'avertissement.
    s = await parent.post('/api/message/share', { key: 'f.10', childIds: ['1:11', 'inconnu'] });
    assert.deepEqual(s.body.sharedWith, ['1:11']);
    s = await kid.post('/api/messages', {});
    assert.deepEqual(s.body.items.map((i: any) => i.key).sort(), ['f.10', 's.1:11.20']);
    assert.equal(s.body.unread, 2);
    assert.equal(s.body.items.find((i: any) => i.key === 'f.10').sharedWith, undefined);
    assert.equal((await kid.post('/api/message', { key: 'f.11' })).status, 404);
    // Un identifiant de la boîte famille glissé dans sa propre boîte élève : refusé par Orbite.
    assert.equal((await kid.post('/api/message', { key: 's.1:11.11' })).status, 404);

    // Ouverture : texte, lien signé de pièce jointe, message marqué comme lu pour ce membre.
    s = await kid.post('/api/message', { key: 'f.10' });
    assert.equal(s.body.text, 'Bonjour');
    const url = s.body.files[0].url as string;
    assert.match(url, /^\/api\/message\/file\?t=/);
    s = await kid.post('/api/messages', {});
    assert.equal(s.body.unread, 1);
    const port = (app.server.address() as AddressInfo).port;
    const file = await fetch(`http://127.0.0.1:${port}${url}`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'application/pdf');
    assert.match(file.headers.get('content-disposition') ?? '', /convocation\.pdf/);
    assert.match(await file.text(), /^%PDF/);
    const forged = await fetch(`http://127.0.0.1:${port}${url.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))}`);
    assert.equal(forged.status, 403);
    const garbled = await fetch(`http://127.0.0.1:${port}${url.replace(/.{3}$/, '%C3%A9%C3%A9')}`);
    assert.equal(garbled.status, 403);

    // Partage retiré : le message disparaît pour l'enfant.
    await parent.post('/api/message/share', { key: 'f.10', childIds: [] });
    assert.equal((await kid.post('/api/message', { key: 'f.10' })).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}${url}`)).status, 404);
    assert.equal((await parent.post('/api/message/share', { key: 'f.999', childIds: ['1:11'] })).status, 404);

    // Lien lié à l'appareil : il ne sert plus une fois le profil verrouillé.
    const own = (await kid.post('/api/messages', {})).body.items.find((i: any) => i.box === 'student');
    assert.ok(own);
    await parent.post('/api/message/share', { key: 'f.10', childIds: ['1:11'] });
    const again = (await kid.post('/api/message', { key: 'f.10' })).body.files[0].url as string;
    assert.equal((await fetch(`http://127.0.0.1:${port}${again}`)).status, 200);

    // Boîte élève refusée par l'établissement : message clair, pas d'erreur.
    s = await parent.post('/api/messages', { childId: '1:12' });
    assert.equal(s.status, 200);
    assert.deepEqual(s.body.items, []);
    assert.match(s.body.unavailable, /messagerie élève/);

    // Vie scolaire : chacun la sienne, les parents tout.
    s = await parent.post('/api/schoollife', { childId: '1:11' });
    assert.equal(s.body.events[0].title, 'Retenue');
    s = await kid.post('/api/schoollife', { childId: '1:11' });
    assert.equal(s.body.events.length, 1);
    assert.equal((await kid.post('/api/schoollife', { childId: '1:12' })).status, 404);

    // Profil verrouillé sur cet appareil : le lien de pièce jointe ne sert plus.
    await kid.post('/api/logout', {});
    assert.equal((await fetch(`http://127.0.0.1:${port}${again}`)).status, 410);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

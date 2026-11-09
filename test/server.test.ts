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
import { EdError, type Factor } from '../src/server/ecoledirecte.ts';
import type { EdClient } from '../src/server/ed-service.ts';
import type { Coach } from '../src/server/coach.ts';
import type { AuthResult, AuthState, Dashboard, HomeworkPage, Note } from '../src/shared/types.ts';

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
        { id: '1:11', name: 'Ilan', className: '5e B', notes: FakeEd.notes['1:11'] ?? [], periods: [] },
        { id: '1:12', name: 'Sacha', className: '6e A', notes: FakeEd.notes['1:12'] ?? [], periods: [] },
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

async function start(dir: string, seed = 'Julien:parent+admin, Ophélie:parent, Ilan:enfant:5e, Sacha:enfant:6e') {
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
    const julien = app.browser();
    let s = await julien.get('/api/session');
    assert.equal(s.body.setupNeeded, true);
    assert.equal(s.body.members.length, 4);
    const admin = s.body.members.find((m: any) => m.admin);
    assert.equal(admin.name, 'Julien');

    // Depuis Internet : prénoms masqués et installation refusée.
    const stranger = app.browser();
    s = await stranger.get('/api/session', internet);
    assert.deepEqual(s.body.members, []);
    s = await stranger.post('/api/setup', { memberId: admin.id, pin: '482916' }, internet);
    assert.equal(s.status, 403);
    s = await stranger.post('/api/setup', { memberId: admin.id, pin: '482916', code: 'ZZZZ-ZZZZ' }, internet);
    assert.equal(s.status, 403);

    // PIN trop simple refusé, puis installation depuis la maison.
    s = await julien.post('/api/setup', { memberId: admin.id, pin: '123456' });
    assert.equal(s.status, 400);
    s = await julien.post('/api/setup', { memberId: admin.id, pin: '482916' });
    assert.equal(s.status, 200);
    assert.equal(s.body.me.name, 'Julien');
    assert.equal(s.body.setupNeeded, false);

    // Connexion ÉcoleDirecte avec question de sécurité.
    s = await julien.post('/api/admin/ed/connect', { username: 'parent.gonde', password: 'bon', remember: true });
    assert.equal(s.body.state, 'question');
    s = await julien.post('/api/admin/ed/verify', { choice: 0 });
    assert.equal(s.body.state, 'authenticated');
    s = await julien.get('/api/session');
    assert.equal(s.body.ed.link, 'connected');
    assert.equal(s.body.ed.account, 'pa•••de');
    assert.equal(s.body.ed.autoReconnect, true);

    // Le parent voit les deux élèves ; le rattachement par prénom est automatique.
    s = await julien.post('/api/data', {});
    assert.deepEqual(
      s.body.children.map((c: any) => c.name),
      ['Ilan', 'Sacha'],
    );
    s = await julien.get('/api/admin/members');
    const ilan = s.body.members.find((m: any) => m.name === 'Ilan');
    assert.equal(ilan.studentId, '1:11');

    // Activation du profil d'Ilan par code à usage unique.
    s = await julien.post('/api/admin/member/code', { memberId: ilan.id });
    const code = s.body.code as string;
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const ilanPhone = app.browser();
    s = await ilanPhone.post('/api/activate', { name: 'ilan', code: 'ZZZZ-ZZZZ', pin: '730519' }, internet);
    assert.equal(s.status, 403);
    s = await ilanPhone.post('/api/activate', { name: 'ilan', code: code.toLowerCase(), pin: '730519' }, internet);
    assert.equal(s.status, 200);
    assert.equal(s.body.me.role, 'child');
    // Appareil reconnu : les prénoms s'affichent désormais hors de la maison.
    s = await ilanPhone.get('/api/session', internet);
    assert.equal(s.body.members.length, 4);
    // Code consommé.
    s = await app.browser().post('/api/activate', { memberId: ilan.id, code, pin: '730519' });
    assert.equal(s.status, 403);

    // Ilan ne voit que lui et n'accède ni aux devoirs de Sacha ni à l'administration.
    s = await ilanPhone.post('/api/data', {});
    assert.deepEqual(
      s.body.children.map((c: any) => c.id),
      ['1:11'],
    );
    assert.equal(s.body.ed, undefined);
    s = await ilanPhone.post('/api/homework', { childId: '1:12' });
    assert.equal(s.status, 404);
    s = await ilanPhone.post('/api/homework', { childId: '1:11' });
    assert.equal(s.body.homework.length, 1);
    s = await ilanPhone.post('/api/admin/ed/disconnect', {});
    assert.equal(s.status, 403);
    s = await ilanPhone.get('/api/admin/members');
    assert.equal(s.status, 403);
    s = await ilanPhone.get('/api/session');
    assert.equal(s.body.ed, null);

    // Case « fait » partagée avec les parents.
    s = await ilanPhone.post('/api/check', { childId: '1:11', homeworkId: '2026-11-10:111', done: true });
    assert.deepEqual(s.body.checks, ['2026-11-10:111']);
    s = await julien.post('/api/data', {});
    assert.deepEqual(s.body.checks['1:11'], ['2026-11-10:111']);

    // Conseil IA limité à l'élève autorisé.
    s = await ilanPhone.post('/api/coaching', { childId: '1:11' });
    assert.equal(s.body.text, 'Continue comme ça en maths.');
    s = await ilanPhone.post('/api/coaching', { childId: '1:12' });
    assert.equal(s.status, 404);

    // Protections HTTP.
    s = await julien.post('/api/data', {}, { 'x-orbite-client': '0' });
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
    s = await julien.post('/api/data', {}, { origin: 'https://evil.example' });
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
    await b.post('/api/admin/ed/connect', { username: 'parent.gonde', password: 'bon', remember: true });
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
    assert.equal(s.body.me.name, 'Julien');
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
    let s = await phone.post('/api/setup', { memberId: admin.id, pin: '482916', code: formatted }, internet);
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

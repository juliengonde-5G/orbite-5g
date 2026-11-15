/**
 * Plateforme multi-familles : invitations, annuaire, plafond de la clé partagée,
 * et isolation de bout en bout entre la famille « maison » et une famille invitée.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Hub, HubError, slugify, slugPattern } from '../src/server/hub.ts';
import { createHubServer } from '../src/server/hub-server.ts';
import { ClaudeCoach } from '../src/server/coach.ts';
import { MeteredCoach, QuotaError } from '../src/server/quota.ts';
import type { Coach } from '../src/server/coach.ts';
import { Vault } from '../src/server/vault.ts';

class FakeCoach implements Coach {
  configured = false;
  key: string | null = null;
  calls = 0;
  setKey(key: string | null) {
    this.key = key;
    this.configured = !!key;
  }
  async advice() {
    this.calls++;
    return 'Un conseil.';
  }
  async check() {
    return 'ok' as const;
  }
  async complete() {
    this.calls++;
    return 'ok';
  }
}

function withDir(run: (dir: string) => Promise<void> | void) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbite-hub-'));
    try {
      await run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const newHub = (dir: string, clock: { now: Date }, coaches: FakeCoach[] = []) =>
  new Hub(new Vault(dir), {
    directory: dir,
    now: () => clock.now,
    coachFactory: () => {
      const coach = new FakeCoach();
      coaches.push(coach);
      return coach;
    },
  });

test('slugify : sans accent, sans mot réservé, borné', () => {
  assert.equal(slugify('Famille Dupont-Léger'), 'famille-dupont-leger');
  assert.equal(slugify('  Ça va ?  '), 'ca-va');
  assert.equal(slugify('api'), 'famille');
  assert.equal(slugify('!!!'), 'famille');
  assert.ok(slugify('x'.repeat(80)).length <= 20);
});

test(
  'invitation : à usage unique, périmée au bout de sept jours, jamais stockée en clair',
  withDir((dir) => {
    const clock = { now: new Date('2026-11-15T10:00:00Z') };
    const hub = newHub(dir, clock);
    const token = hub.invite('Famille Martin');
    assert.deepEqual(hub.inspect(token), { label: 'Famille Martin' });
    assert.equal(hub.invites().length, 1);
    const { family, setupCode } = hub.create(token, { familyName: 'Famille Martin', adminName: 'Claire' });
    assert.match(family.slug, slugPattern);
    assert.match(setupCode, /^[A-Z2-9]{8}$/);
    assert.equal(family.seed, 'Claire:parent+admin');
    assert.equal(hub.invites().length, 0);
    assert.throws(
      () => hub.inspect(token),
      (e: unknown) => e instanceof HubError && e.code === 404,
    );
    assert.throws(() => hub.create(token, { familyName: 'Autre', adminName: 'Zoé' }), HubError);
    assert.ok(existsSync(join(dir, 'families', family.slug, 'secret.enc')), 'le coffre de la famille est préparé');

    const late = hub.invite('Trop tard');
    clock.now = new Date('2026-11-23T10:00:00Z');
    assert.throws(() => hub.inspect(late), HubError);

    // Le jeton n'apparaît jamais dans le coffre de la plateforme, même déchiffré.
    const doc = JSON.stringify(new Vault(dir).load('hub', null));
    assert.ok(!doc.includes(token) && !doc.includes(late));
  }),
);

test(
  'création : noms contrôlés, deux familles du même nom ont deux liens différents',
  withDir((dir) => {
    const hub = newHub(dir, { now: new Date('2026-11-15T10:00:00Z') });
    const bad = (input: object) => assert.throws(() => hub.create(hub.invite('x'), input), HubError);
    bad({ familyName: 'A', adminName: 'Claire' });
    bad({ familyName: 'Famille', adminName: 'C' });
    bad({ familyName: 'Famille', adminName: 'Claire:parent' });
    bad({ familyName: 'Famille', adminName: 'Claire, Paul' });
    bad({ familyName: 'Famille', adminName: 'A+B' });
    const a = hub.create(hub.invite('a'), { familyName: 'Famille Martin', adminName: 'Claire' }).family;
    const b = hub.create(hub.invite('b'), { familyName: 'Famille Martin', adminName: 'Paul' }).family;
    assert.notEqual(a.slug, b.slug);
    assert.notEqual(hub.familyDir(a.slug), hub.familyDir(b.slug));
    assert.throws(() => hub.familyDir('../../etc'), HubError);
  }),
);

test(
  'jetons devinés : vingt échecs par heure bloquent les essais',
  withDir((dir) => {
    const clock = { now: new Date('2026-11-15T10:00:00Z') };
    const hub = newHub(dir, clock);
    const good = hub.invite('x');
    for (let i = 0; i < 20; i++) assert.throws(() => hub.inspect('a'.repeat(24)), HubError);
    assert.throws(
      () => hub.inspect(good),
      (e: unknown) => e instanceof HubError && e.code === 429,
    );
    clock.now = new Date('2026-11-15T11:30:00Z');
    assert.equal(hub.inspect(good).label, 'x');
  }),
);

test(
  'clé partagée : chaque famille son conseiller et son plafond, remise à zéro chaque jour',
  withDir(async (dir) => {
    const clock = { now: new Date('2026-11-15T10:00:00Z') };
    const coaches: FakeCoach[] = [];
    const hub = newHub(dir, clock, coaches);
    const a = hub.create(hub.invite('a'), { familyName: 'Alpha', adminName: 'Ada' }).family;
    const b = hub.create(hub.invite('b'), { familyName: 'Beta', adminName: 'Bob' }).family;
    hub.setMasterKey('sk-ant-master');
    const coachA = hub.coachFor(a.slug);
    const coachB = hub.coachFor(b.slug);
    assert.equal(coaches.length, 2, 'un conseiller par famille : aucun cache partagé');
    assert.ok(coachA.configured && coachB.configured);
    hub.setMasterKey('sk-ant-nouvelle');
    assert.deepEqual(
      coaches.map((c) => c.key),
      ['sk-ant-nouvelle', 'sk-ant-nouvelle'],
    );

    hub.update(a.slug, { dailyLimit: 2 });
    await coachA.advice('c1', { notes: [] });
    await coachA.complete('s', 'u', 10);
    await assert.rejects(() => coachA.advice('c1', { notes: [] }), QuotaError);
    await assert.rejects(() => coachA.complete('s', 'u', 10), /limite quotidienne/);
    assert.equal(coaches[0]?.calls, 2, 'au-delà du plafond, Claude n’est pas appelé');
    await coachB.advice('c1', { notes: [] });
    assert.deepEqual(
      hub.list().map((f) => [f.name, f.usedToday]),
      [
        ['Alpha', 2],
        ['Beta', 1],
      ],
    );

    clock.now = new Date('2026-11-16T09:00:00Z');
    assert.equal(hub.list()[0]?.usedToday, 0);
    await coachA.advice('c1', { notes: [] });

    hub.update(a.slug, { disabled: true });
    await assert.rejects(() => coachA.advice('c1', { notes: [] }), /suspendue/);
    hub.update(a.slug, { disabled: false, dailyLimit: 0 });
    await assert.rejects(() => coachA.advice('c1', { notes: [] }), QuotaError);

    assert.throws(() => hub.update(a.slug, { dailyLimit: -1 }), HubError);
    assert.throws(() => hub.update(a.slug, { dailyLimit: 9999 }), HubError);
    assert.throws(() => hub.update(a.slug, { dailyLimit: 1.5 }), HubError);
    assert.throws(
      () => hub.update('inconnue-abcd', { disabled: true }),
      (e: unknown) => e instanceof HubError && e.code === 404,
    );
  }),
);

test('MeteredCoach : la famille ne peut ni changer ni vérifier la clé', async () => {
  const inner = new FakeCoach();
  inner.setKey('sk-ant-master');
  const metered = new MeteredCoach(inner, { take() {} });
  metered.setKey(null);
  assert.equal(inner.key, 'sk-ant-master');
  await assert.rejects(() => metered.check('sk-ant-x'), QuotaError);
});

test(
  'création : un prénom avec séparateur ou sans lettre est refusé avant de consommer l’invitation',
  withDir(async (dir) => {
    const hub = newHub(dir, { now: new Date('2026-11-15T10:00:00Z') });
    const token = hub.invite('Test');
    for (const adminName of [';;', 'Léa;Max', '--', 'a,b'])
      assert.throws(() => hub.create(token, { familyName: 'Famille', adminName }), HubError, adminName);
    assert.equal(hub.invites().length, 1, 'l’invitation reste utilisable');
    assert.ok(hub.create(token, { familyName: 'Famille', adminName: 'Léa' }).family.slug);
  }),
);

test(
  'suppression : réservée aux familles suspendues, efface fiche, dossier et invitation',
  withDir(async (dir) => {
    const clock = { now: new Date('2026-11-15T10:00:00Z') };
    const hub = newHub(dir, clock);
    const { family } = hub.create(hub.invite('Martin'), { familyName: 'Famille Martin', adminName: 'Claire' });
    assert.ok(existsSync(hub.familyDir(family.slug)));
    assert.throws(() => hub.remove(family.slug), HubError, 'pas sans suspension');
    hub.update(family.slug, { disabled: true });
    let closed = '';
    hub.onRemoved = (slug) => (closed = slug);
    hub.remove(family.slug);
    assert.equal(closed, family.slug);
    assert.ok(!existsSync(hub.familyDir(family.slug)));
    assert.equal(hub.invites().length, 0);
    const again = newHub(dir, clock);
    assert.equal(again.get(family.slug), undefined, 'rien ne la recrée au redémarrage');
    assert.throws(() => again.remove(family.slug), HubError);
  }),
);

test('MeteredCoach : un conseil servi par le cache ne consomme pas le plafond', async () => {
  let upstream = 0;
  const transport = (async () => {
    upstream++;
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'Révise un peu chaque soir.' }] }), {
      status: 200,
    });
  }) as typeof fetch;
  const inner = new ClaudeCoach('sk-ant-master', 'm', transport);
  let used = 0;
  const metered = new MeteredCoach(inner, {
    take() {
      if (used >= 2) throw new QuotaError('plafond');
      used++;
    },
  });
  const child = {
    notes: [1, 2, 3].map((i) => ({
      id: i,
      subject: 'Maths',
      subjectId: '1:',
      title: 'Contrôle ' + i,
      raw: String(10 + i),
      value: 10 + i,
      outOf: 20,
      coefficient: 1,
      classAverage: null,
      excluded: false,
      date: new Date().toISOString().slice(0, 10),
    })),
  } as never;
  await metered.advice('e1', child);
  await metered.advice('e1', child);
  await metered.advice('e1', child);
  assert.equal(upstream, 1);
  assert.equal(used, 1);
});

/* ---------- Bout en bout ---------- */

/** Navigateur minimal : cookies avec leur chemin, le plus précis envoyé en premier. */
function browser(port: number) {
  const jar: { name: string; value: string; path: string }[] = [];
  const call = async (method: string, path: string, data?: unknown, headers: Record<string, string> = {}) => {
    const cookie = jar
      .filter((c) => path === c.path || path.startsWith(c.path.endsWith('/') ? c.path : c.path + '/'))
      .sort((a, b) => b.path.length - a.path.length)
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        ...(method === 'POST' ? { 'content-type': 'application/json', 'x-orbite-client': '1' } : {}),
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      body: method === 'POST' ? JSON.stringify(data ?? {}) : null,
    });
    const set = res.headers.getSetCookie();
    for (const line of set) {
      const [pair = '', ...attrs] = line.split('; ');
      const [name = '', value = ''] = pair.split('=');
      const path = attrs.find((a) => a.startsWith('Path='))?.slice(5) ?? '/';
      const at = jar.findIndex((c) => c.name === name && c.path === path);
      if (at >= 0) jar.splice(at, 1);
      if (value && !attrs.includes('Max-Age=0')) jar.push({ name, value, path });
    }
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: res.status, body, text, location: res.headers.get('location'), set };
  };
  return {
    get: (p: string, h?: Record<string, string>) => call('GET', p, undefined, h),
    post: (p: string, d?: unknown, h?: Record<string, string>) => call('POST', p, d, h),
    jar,
  };
}

test(
  'deux familles : liens distincts, sessions séparées, clé Claude gérée, suspension',
  withDir(async (dir) => {
    const server = createHubServer({
      vault: new Vault(dir),
      familySeed: 'Julien:parent+admin',
      version: '1.6.0',
      refreshFloor: 0,
      coach: new FakeCoach(),
      hubOptions: { coachFactory: () => new FakeCoach() },
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const julien = browser(port);
      assert.equal((await julien.post('/api/setup', { name: 'Julien', pin: '482916' })).status, 200);
      const home = (await julien.get('/api/session')).body;
      assert.equal(home.hub, true);
      assert.equal(home.keyManaged, false);

      // Inviter : réservé à l'administrateur de la famille « maison ».
      assert.equal((await browser(port).post('/api/hub/invite', { label: 'x' })).status, 401);
      const invited = await julien.post('/api/hub/invite', { label: 'Famille Martin' });
      assert.equal(invited.status, 200);
      assert.ok(Array.isArray(invited.body.families), 'la liste des familles accompagne l’invitation');
      const token = (invited.body.path as string).replace('/invite/', '');
      const page = await browser(port).get(invited.body.path);
      assert.equal(page.status, 200);
      assert.ok(page.text.includes(`name="orbite-invite" content="${token}"`));
      assert.equal((await browser(port).get('/invite/trop-court')).status, 404);

      // La famille se crée toute seule avec le lien d'invitation, sans connexion préalable.
      const claire = browser(port);
      assert.equal((await claire.post('/api/hub/invite/check', { token })).body.label, 'Famille Martin');
      assert.equal((await claire.post('/api/hub/invite/check', { token: 'x'.repeat(24) })).status, 404);
      const created = await claire.post('/api/hub/family/create', {
        token,
        familyName: 'Famille Martin',
        adminName: 'Claire',
      });
      assert.equal(created.status, 200);
      const base = (created.body.url as string).replace(/\/$/, '');
      assert.match(base, /^\/f\/famille-martin-[a-z0-9]{4}$/);
      assert.equal(
        (await claire.post('/api/hub/family/create', { token, familyName: 'Bis', adminName: 'Zoé' })).status,
        404,
      );

      // Page, manifeste et redirection propres à la famille.
      assert.equal((await claire.get(base)).location, `${base}/`);
      const index = await claire.get(`${base}/`);
      assert.ok(index.text.includes(`name="orbite-base" content="${base}"`));
      assert.ok(index.text.includes(`href="${base}/manifest.webmanifest"`));
      const manifest = (await claire.get(`${base}/manifest.webmanifest`)).body;
      assert.equal(manifest.start_url, `${base}/`);
      assert.equal(manifest.scope, `${base}/`);
      assert.ok(!(await julien.get('/')).text.includes('orbite-base'));
      assert.equal((await julien.get('/manifest.webmanifest')).body.start_url, '/');
      assert.equal((await claire.get(`${base}/style.css`)).status, 200);
      assert.equal((await claire.get('/f/inconnue-abcd/')).status, 404);

      // Le parent choisit son PIN avec le code que seule la page d'invitation connaît.
      const remote = { 'x-forwarded-for': '203.0.113.9' };
      assert.equal(
        (await claire.post(`${base}/api/setup`, { name: 'Claire', pin: '730519', code: 'FAUX-CODE' }, remote)).status >=
          400,
        true,
      );
      const setup = await claire.post(
        `${base}/api/setup`,
        { name: 'Claire', pin: '730519', code: created.body.setupCode },
        remote,
      );
      assert.equal(setup.status, 200);
      assert.ok(
        setup.set.some((c) => c.startsWith('o5g=') && c.includes(`Path=${base}`)),
        'le cookie ne sort pas de la famille',
      );
      const mine = (await claire.get(`${base}/api/session`)).body;
      assert.equal(mine.me.name, 'Claire');
      assert.equal(mine.keyManaged, true);
      assert.equal(mine.hub, false);
      assert.equal(mine.familyName, 'Famille Martin');

      // Isolation : le cookie de l'une n'ouvre pas la famille de l'autre, et inversement.
      const cross = browser(port);
      cross.jar.push({ name: 'o5g', value: julien.jar.find((c) => c.name === 'o5g')!.value, path: '/' });
      assert.equal(
        (await cross.get(`${base}/api/session`)).body.me,
        null,
        'la session de Julien ne passe pas chez Claire',
      );
      const reverse = browser(port);
      reverse.jar.push({ name: 'o5g', value: claire.jar.find((c) => c.name === 'o5g')!.value, path: '/' });
      assert.equal((await reverse.get('/api/session')).body.me, null, 'la session de Claire ne passe pas chez Julien');
      assert.equal(
        (await claire.get('/api/session')).body.me,
        null,
        'le cookie de la famille n’est pas envoyé à la racine',
      );
      assert.equal((await julien.get(`${base}/api/admin/members`)).status, 401);

      // La plateforme n'existe pas dans une famille ; la clé Claude n'y est pas modifiable.
      assert.equal((await claire.post(`${base}/api/hub/invite`, { label: 'x' })).status, 404);
      assert.equal((await claire.get(`${base}/api/hub/families`)).status, 404);
      assert.equal((await claire.post(`${base}/api/admin/claude`, { key: 'sk-ant-' + 'a'.repeat(30) })).status, 403);
      assert.equal((await claire.post(`${base}/api/admin/claude/remove`)).status, 403);
      assert.equal((await claire.get(`${base}/api/admin/claude`)).body.managed, true);

      // Suivi par l'administrateur : jamais de donnée de la famille.
      const overview = (await julien.get('/api/hub/families')).body;
      assert.equal(overview.families.length, 1);
      assert.deepEqual(Object.keys(overview.families[0]).sort(), [
        'createdAt',
        'dailyLimit',
        'disabled',
        'name',
        'slug',
        'usedToday',
      ]);
      assert.equal((await claire.get(`${base}/api/hub/families`)).status, 404);
      assert.equal(
        (await julien.post('/api/hub/family/update', { slug: overview.families[0].slug, dailyLimit: -5 })).status,
        400,
      );
      const slug = overview.families[0].slug as string;

      // Suspension : le lien ne répond plus, les données restent ; rétablie, tout revient.
      assert.equal((await julien.post('/api/hub/family/update', { slug, disabled: true })).status, 200);
      assert.equal((await claire.get(`${base}/`)).status, 403);
      assert.equal((await claire.get(`${base}/api/session`)).status, 403);
      assert.equal((await julien.post('/api/hub/family/update', { slug, disabled: false })).status, 200);
      assert.equal((await claire.get(`${base}/api/session`)).body.me.name, 'Claire');
      assert.equal((await julien.get('/healthz')).body.version, '1.6.0');
    } finally {
      await new Promise((r) => server.close(r));
    }
  }),
);

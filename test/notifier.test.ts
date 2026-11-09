/**
 * Notifications de la famille : premier passage sans envoi, nouveautés adressées aux
 * bons membres, rien de chiffré sur l'écran verrouillé, appareils déconnectés retirés,
 * préférences, heures calmes, rappel du cartable et récapitulatif du dimanche.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from '../src/server/vault.ts';
import { Notifier, type NotifierEd, type PushMessage } from '../src/server/notifier.ts';
import type { Family, MemberRecord } from '../src/server/family.ts';
import type { Course, Dashboard, Note, SchoolLife } from '../src/shared/types.ts';
import type { EdMail } from '../src/server/ecoledirecte.ts';

const member = (id: string, role: 'parent' | 'child', studentId: string | null = null) =>
  ({ id, name: id, role, studentId }) as MemberRecord;

const subscription = (n: number) => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/device-${n}`,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
  };
};

const note = (id: string, subject: string, date: string): Note => ({
  id,
  subject,
  subjectId: subject + ':',
  title: 'Contrôle',
  date,
  raw: '17',
  value: 17,
  outOf: 20,
  coefficient: 1,
  classAverage: 12,
  excluded: false,
});

function setup(now: { value: Date }) {
  const dir = mkdtempSync(join(tmpdir(), 'o5g-push-'));
  const members = [member('papa', 'parent'), member('leo', 'child', '1:21'), member('nina', 'child', '1:22')];
  const active = new Set(['papa:t-papa', 'leo:t-leo', 'nina:t-nina']);
  const family = {
    members,
    deviceActive: (id: string, tag: string) => active.has(`${id}:${tag}`),
  } as unknown as Family;
  const data = {
    notes: { '1:21': [note('a', 'MATHS', '2026-11-02')], '1:22': [] as Note[] },
    mail: { famille: [] as EdMail[], '1:21': [] as EdMail[], '1:22': [] as EdMail[] } as Record<string, EdMail[]>,
    life: { '1:21': { events: [] }, '1:22': { events: [] } } as Record<string, SchoolLife>,
    courses: [] as Course[],
    /** Pannes simulées : emploi du temps ÉcoleDirecte, service push. */
    timetableDown: false,
    pushDown: false,
  };
  const ed: NotifierEd = {
    dashboard: async () => ({
      dashboard: {
        updatedAt: '',
        children: [
          { id: '1:21', name: 'Léo', notes: data.notes['1:21'], periods: [] },
          { id: '1:22', name: 'Nina', notes: data.notes['1:22'], periods: [] },
        ],
      } as unknown as Dashboard,
      stale: false,
    }),
    mailbox: async (id) => data.mail[id ?? 'famille'] ?? [],
    schoolLife: async (id) => data.life[id] ?? { events: [] },
    timetable: async () => {
      if (data.timetableDown) throw new Error('ÉcoleDirecte indisponible');
      return data.courses;
    },
    status: () => ({ link: 'connected' }),
  };
  const sent: { endpoint: string; message: PushMessage }[] = [];
  const gone = new Set<string>();
  const notifier = new Notifier({
    vault: new Vault(dir),
    family,
    ed,
    subject: 'https://orbite.example.org',
    now: () => now.value,
    send: async (sub, message) => {
      if (gone.has(sub.endpoint)) return 'gone';
      if (data.pushDown) return 'failed';
      sent.push({ endpoint: sub.endpoint, message: message as PushMessage });
      return 'sent';
    },
  });
  const [papa, leo, nina] = members as [MemberRecord, MemberRecord, MemberRecord];
  assert.ok(notifier.subscribe(papa, 't-papa', subscription(1)));
  assert.ok(notifier.subscribe(leo, 't-leo', subscription(2)));
  assert.ok(notifier.subscribe(nina, 't-nina', subscription(3)));
  return { dir, notifier, data, sent, gone, active, papa, leo, nina };
}

const to = (sent: { endpoint: string; message: PushMessage }[], n: number) =>
  sent.filter((s) => s.endpoint.endsWith(`device-${n}`)).map((s) => s.message);

test('notifications : référence au premier passage, puis nouveautés aux bons membres', async () => {
  const now = { value: new Date('2026-11-04T15:00:00Z') };
  const t = setup(now);
  try {
    await t.notifier.scan();
    assert.equal(t.sent.length, 0, 'rien pour l’existant');

    t.data.notes['1:21']?.push(note('b', 'FRANCAIS', '2026-11-04'), note('old', 'ANGLAIS', '2026-09-01'));
    t.data.mail['1:21'] = [
      { id: '9', subject: 'Sortie au musée', from: 'M. Durand', fromRole: 'teacher', date: '', read: false, files: [] },
    ];
    t.data.mail.famille = [
      { id: '7', subject: 'Réunion parents', from: 'Direction', fromRole: 'staff', date: '', read: false, files: [] },
      { id: '8', subject: 'Déjà lu', from: 'Direction', fromRole: 'staff', date: '', read: true, files: [] },
    ];
    t.data.life['1:21'] = {
      events: [
        { id: 'p1', kind: 'punition', type: 'Retenue', title: 'Retenue', reason: 'Bavardages' } as never,
        { id: 'e1', kind: 'encouragement', type: 'Félicitations', title: 'Félicitations' } as never,
      ],
    };
    await t.notifier.scan();

    const leo = to(t.sent, 2);
    const papa = to(t.sent, 1);
    const nina = to(t.sent, 3);
    assert.deepEqual(
      leo.map((m) => m.title),
      ['Nouvelle note', 'Nouveau message', 'Encouragement'],
    );
    assert.equal(leo[0]?.body, 'FRANCAIS · Contrôle', 'note récente seule, sans valeur chiffrée');
    assert.ok(!JSON.stringify(t.sent).includes('17'), 'jamais la note sur l’écran verrouillé');
    assert.ok(!leo.some((m) => m.title.includes('Punition')), 'sanctions aux parents seulement');
    assert.deepEqual(
      papa.map((m) => m.title).sort(),
      [
        'Léo · Encouragement',
        'Léo · Nouveau message',
        'Léo · Nouvelle note',
        'Léo · Punition',
        'Nouveau message',
      ].sort(),
    );
    assert.equal(papa.find((m) => m.title === 'Léo · Punition')?.body, 'Retenue · Bavardages');
    assert.equal(nina.length, 0, 'une élève ne reçoit rien des autres');

    // Rien de nouveau : rien n'est renvoyé.
    t.sent.length = 0;
    await t.notifier.scan();
    assert.equal(t.sent.length, 0);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test('notifications : préférences, appareil déconnecté ou expiré retiré, partage', async () => {
  const now = { value: new Date('2026-11-04T15:00:00Z') };
  const t = setup(now);
  try {
    await t.notifier.scan();
    t.notifier.setPrefs(t.papa, { notes: false, bogus: true });
    assert.equal(t.notifier.prefs(t.papa.id).notes, false);
    assert.equal('bogus' in t.notifier.prefs(t.papa.id), false);
    t.active.delete('nina:t-nina');
    t.gone.add('https://fcm.googleapis.com/fcm/send/device-2');
    t.data.notes['1:21']?.push(note('c', 'SVT', '2026-11-04'));
    await t.notifier.scan();
    assert.equal(to(t.sent, 1).length, 0, 'préférence respectée');
    assert.equal(t.notifier.status(t.leo, 't-leo').subscribed, false, 'abonnement expiré supprimé');

    await t.notifier.shared(['1:22'], 'Réunion parents');
    assert.equal(to(t.sent, 3).length, 0, 'appareil déconnecté : plus rien');
    assert.equal(t.notifier.status(t.nina, 't-nina').subscribed, false);

    assert.equal(t.notifier.subscribe(t.leo, 't-leo', { endpoint: 'https://evil.example/x', keys: {} }), false);
    assert.equal(t.notifier.subscribe(t.leo, '', subscription(9)), false, 'appareil inconnu refusé');
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test('notifications : heures calmes, cartable à 19 h la veille d’un jour de classe, récap du dimanche', async () => {
  // Mercredi 4 novembre 2026, 23 h à Paris : rien ne part.
  const now = { value: new Date('2026-11-04T22:00:00Z') };
  const t = setup(now);
  try {
    await t.notifier.tick();
    assert.equal(t.sent.length, 0);

    // 19 h 10 : cours le lendemain → rappel, une seule fois.
    now.value = new Date('2026-11-04T18:10:00Z');
    t.data.courses = [
      { subject: 'MATHS', start: '08:30', cancelled: false, kind: 'cours' } as Course,
      { subject: 'EPS', start: '10:30', cancelled: true, kind: 'cours' } as Course,
    ];
    await t.notifier.tick();
    await t.notifier.tick();
    const bag = to(t.sent, 2).filter((m) => m.url === '/#cartable');
    assert.equal(bag.length, 1);
    assert.match(bag[0]?.body ?? '', /^1 cours demain, dès 08 h 30/);
    assert.equal(to(t.sent, 1).filter((m) => m.url === '/#cartable').length, 0, 'pas pour les parents');

    // Vendredi soir : pas de cours le samedi.
    t.sent.length = 0;
    now.value = new Date('2026-11-06T18:10:00Z');
    await t.notifier.tick();
    assert.equal(to(t.sent, 2).filter((m) => m.url === '/#cartable').length, 0);

    // Dimanche 8 novembre, 18 h 30 : récapitulatif pour les parents, une seule fois.
    now.value = new Date('2026-11-08T17:30:00Z');
    t.data.notes['1:21']?.push(note('d', 'SVT', '2026-11-06'));
    await t.notifier.recap(now.value);
    await t.notifier.recap(now.value);
    const recap = to(t.sent, 1).filter((m) => m.url === '/#recap');
    assert.equal(recap.length, 1);
    assert.equal(recap[0]?.body, 'Léo : 2 notes · Nina : aucune note');
    assert.equal(to(t.sent, 2).filter((m) => m.url === '/#recap').length, 0);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test('notifications : rappel et récap retentés après une panne, envoyés une seule fois', async () => {
  const now = { value: new Date('2026-11-04T18:05:00Z') };
  const t = setup(now);
  try {
    t.data.courses = [{ subject: 'MATHS', start: '08:30', cancelled: false, kind: 'cours' } as Course];
    const bag = () => to(t.sent, 2).filter((m) => m.url === '/#cartable').length;
    t.data.timetableDown = true;
    await t.notifier.bagReminder(now.value);
    t.data.timetableDown = false;
    t.data.pushDown = true;
    await t.notifier.bagReminder(now.value);
    assert.equal(bag(), 0, 'deux échecs : rien d’envoyé');
    t.data.pushDown = false;
    await t.notifier.bagReminder(now.value);
    await t.notifier.bagReminder(now.value);
    assert.equal(bag(), 1, 'envoyé au passage suivant, une seule fois');

    const sunday = new Date('2026-11-08T17:30:00Z');
    t.data.pushDown = true;
    await t.notifier.recap(sunday);
    t.data.pushDown = false;
    await t.notifier.recap(sunday);
    await t.notifier.recap(sunday);
    assert.equal(to(t.sent, 1).filter((m) => m.url === '/#recap').length, 1);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test('notifications : file d’envoi — échec retenté sans doublon, heures calmes, longues listes', async () => {
  const now = { value: new Date('2026-11-04T15:00:00Z') };
  const t = setup(now);
  try {
    await t.notifier.scan();
    // Service push en panne pendant le passage : la nouveauté reste en file.
    t.data.notes['1:21']?.push(note('e', 'SVT', '2026-11-04'));
    t.data.pushDown = true;
    await t.notifier.scan();
    assert.equal(t.sent.length, 0);
    t.data.pushDown = false;
    await t.notifier.flush();
    await t.notifier.flush();
    assert.equal(to(t.sent, 2).filter((m) => m.title === 'Nouvelle note').length, 1, 'retentée, une seule fois');
    assert.equal(to(t.sent, 1).filter((m) => m.title === 'Léo · Nouvelle note').length, 1);

    // Partage à 23 h : rien avant 7 h, puis envoyé au premier passage du matin.
    t.sent.length = 0;
    now.value = new Date('2026-11-04T22:00:00Z');
    await t.notifier.shared(['1:21'], 'Réunion parents');
    await t.notifier.tick();
    assert.equal(t.sent.length, 0, 'heures calmes respectées');
    now.value = new Date('2026-11-05T06:05:00Z');
    await t.notifier.tick();
    assert.deepEqual(
      to(t.sent, 2).map((m) => m.title),
      ['Un parent t’a partagé un message'],
    );

    // Plus de 600 notes inchangées : rien n'est réannoncé.
    t.sent.length = 0;
    const many = Array.from({ length: 650 }, (_, i) => note(`n${i}`, 'MATHS', '2026-11-03'));
    t.data.notes['1:22'] = many;
    await t.notifier.scan();
    t.sent.length = 0;
    await t.notifier.scan();
    await t.notifier.scan();
    assert.equal(t.sent.length, 0, 'aucune note déjà vue réannoncée');
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

/**
 * Audit quotidien du soutien : trois compétences par jour, plan fixé le matin,
 * notifications adaptées à l'élève, suivi des parents.
 *
 * Fonctionnement : horloge simulée, faux notificateur qui garde les messages mis en file,
 * coffre dans un dossier temporaire.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activationMessage,
  dailyMessage,
  emptySupport,
  focusesOf,
  monitorOf,
  planDay,
  type Focus,
} from '../src/shared/support.ts';
import { Support, type ExerciseWriter } from '../src/server/support.ts';
import { announceActivation, runDailyAudit } from '../src/server/support-daily.ts';
import { Vault } from '../src/server/vault.ts';
import type { Family, MemberRecord } from '../src/server/family.ts';
import type { Notifier, PushMessage } from '../src/server/notifier.ts';
import type { Dashboard, Note, Skill } from '../src/shared/types.ts';

const NOW = new Date('2026-11-12T08:00:00+01:00');

const note = (subject: string, date: string, value = 12, skills: Skill[] = []): Note => ({
  subject,
  subjectId: subject + ':',
  title: 'Évaluation',
  date,
  raw: String(value),
  value,
  outOf: 20,
  coefficient: 1,
  classAverage: 12,
  excluded: false,
  skills,
});
const skill = (name: string, level: Skill['level'], id = name): Skill => ({
  name,
  detail: '',
  level,
  competenceId: id,
});

test('trois compétences par jour, même sans aucune note', () => {
  const focuses = focusesOf({ notes: [] }, NOW);
  assert.deepEqual(focuses.map((f) => f.key).sort(), ['s:anglais', 's:francais', 's:maths']);
  assert.equal(planDay(focuses, { focuses: {} }, '2026-11-12').length, 3);
});

test('un point faible récent passe avant un point faible ancien de même niveau', () => {
  const focuses = focusesOf(
    {
      notes: [
        note('MATHS', '2026-09-01', 12, [skill('Ancienne lacune', 1, 'OLD')]),
        note('FRANCAIS', '2026-11-08', 12, [skill('Lacune récente', 1, 'NEW')]),
      ],
    },
    NOW,
  );
  const plan = planDay(focuses, { focuses: {} }, '2026-11-12');
  assert.equal(plan[0]?.focus.key, 'c:francais:NEW');
  assert.equal(plan[0]?.focus.urgent, true);
  assert.equal(focuses.find((f) => f.key === 'c:maths:OLD')?.urgent, undefined);
});

test('un plan complété par des révisions reste de trois modules', () => {
  const strong: Focus[] = ['a', 'b', 'c'].map((key, i) => ({
    key,
    subject: (['maths', 'francais', 'anglais'] as const)[i]!,
    label: key,
    mastery: 1,
    source: 'competence',
  }));
  const plan = planDay(strong, { focuses: {} }, '2026-11-12');
  assert.equal(plan.length, 3);
  assert.ok(plan.every((p) => p.reason === 'review'));
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'o5g-daily-'));
  const clock = { value: new Date(NOW) };
  const writer: ExerciseWriter = {
    available: true,
    async write() {
      throw new Error('inutile ici');
    },
  };
  const support = new Support(new Vault(dir), writer, () => clock.value);
  const child = {
    id: '1:11',
    name: 'Léo',
    className: '6E2',
    notes: [
      note('MATHS', '2026-11-05', 8, [skill('Calculer avec des fractions', 1, 'C1')]),
      note('FRANCAIS', '2026-11-06', 10, [skill('Accorder le participe passé', 2, 'C2')]),
      note('ANGLAIS', '2026-10-25', 14, [skill('Comprendre un texte court', 4, 'C3')]),
    ],
  };
  return { support, child, clock };
}

test('audit : le plan est fixé le matin et ne bouge plus de la journée', () => {
  const { support, child, clock } = setup();
  support.setEnabled('1:11', true);
  assert.equal(support.auditDay('1:11', child)?.items.length, 3);
  const before = support.status('1:11', child).plan.map((p) => p.key);
  // ÉcoleDirecte reçoit une nouvelle note : le plan du jour est inchangé.
  child.notes.push(note('MATHS', '2026-11-12', 3, [skill('Autre lacune', 1, 'C9')]));
  assert.deepEqual(
    support.status('1:11', child).plan.map((p) => p.key),
    before,
  );
  assert.equal(support.auditDay('1:11', child), null, 'un seul audit par jour');
  // Le lendemain, l'audit est refait et tient compte de la nouvelle note.
  clock.value = new Date('2026-11-13T07:00:00+01:00');
  const next = support.auditDay('1:11', child);
  assert.equal(next?.items.length, 3);
  assert.ok(next?.items.some((p) => p.focus.key === 'c:maths:C9'));
});

test('audit : rien tant que le soutien n’est pas activé ; l’activation refait l’audit', () => {
  const { support, child } = setup();
  assert.equal(support.auditDay('1:11', child), null);
  assert.equal(support.setEnabled('1:11', true), true);
  assert.equal(support.setEnabled('1:11', true), false, 'pas de changement');
  assert.ok(support.auditDay('1:11', child));
  support.setEnabled('1:11', false);
  support.setEnabled('1:11', true);
  assert.ok(support.auditDay('1:11', child), 'nouvelle activation : nouvel audit');
});

function fakeNotifier() {
  const sent: { to: string[]; message: PushMessage; pref: string | null }[] = [];
  const notifier = {
    async queue(members: MemberRecord[], message: PushMessage, pref: string | null) {
      sent.push({ to: members.map((m) => m.id), message, pref });
    },
  } as unknown as Notifier;
  return { notifier, sent };
}

const kid = (name: string) => ({ id: `m-${name}`, name, role: 'child', studentId: '1:11' }) as MemberRecord;
const familyOf = (...members: MemberRecord[]) => ({ members }) as unknown as Family;

test('notification du matin : une fois par jour, après 6 h, ton adapté à la classe', async () => {
  const { support, child, clock } = setup();
  const { notifier, sent } = fakeNotifier();
  const dashboard = { children: [child] } as unknown as Dashboard;
  const options = () => ({
    support,
    family: familyOf(kid('Léo')),
    notifier,
    ed: { dashboard: async () => ({ dashboard, stale: false }) },
    now: () => clock.value,
  });
  support.setEnabled('1:11', true);

  clock.value = new Date('2026-11-12T05:30:00+01:00');
  assert.equal(await runDailyAudit(options()), 0, 'trop tôt');

  clock.value = new Date('2026-11-12T06:05:00+01:00');
  assert.equal(await runDailyAudit(options()), 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.pref, 'support');
  assert.deepEqual(sent[0]?.to, ['m-Léo']);
  assert.match(sent[0]!.message.title, /Léo/, 'un 6e est appelé par son prénom');
  assert.match(sent[0]!.message.body, /Maths/);

  assert.equal(await runDailyAudit(options()), 0, 'une seule notification par jour');
  clock.value = new Date('2026-11-13T06:10:00+01:00');
  assert.equal(await runDailyAudit(options()), 1);
});

test('notification : sans ÉcoleDirecte, l’audit est reporté et rien n’est envoyé', async () => {
  const { support, child, clock } = setup();
  const { notifier, sent } = fakeNotifier();
  support.setEnabled('1:11', true);
  clock.value = new Date('2026-11-12T09:00:00+01:00');
  const down = {
    support,
    family: familyOf(kid('Léo')),
    notifier,
    ed: { dashboard: async () => ({ dashboard: null, stale: true }) },
    now: () => clock.value,
  };
  assert.equal(await runDailyAudit(down), 0);
  assert.equal(support.pendingNotice('1:11'), null);
  assert.equal(sent.length, 0);
  assert.ok(child);
});

test('messages : ton joueur en 6e et 5e, plus sobre ensuite', () => {
  const young = activationMessage('Léo', '6E2');
  const older = activationMessage('Léo', '3ème B');
  assert.match(young.title, /Léo/);
  assert.match(young.body, /défis/);
  assert.doesNotMatch(older.title, /Léo/);
  assert.match(older.body, /modules/);
  const items = [
    { focus: { subject: 'maths' } },
    { focus: { subject: 'maths' } },
    { focus: { subject: 'anglais' } },
  ] as never;
  assert.match(dailyMessage('Léo', '5e', items).body, /Maths et Anglais/);
  assert.match(dailyMessage('Léo', '4e', items).title, /entraînement/);
});

test('activation : l’élève est prévenu avec le ton de sa classe', async () => {
  const { notifier, sent } = fakeNotifier();
  await announceActivation(
    familyOf(kid('Léo'), { ...kid('Maman'), role: 'parent' } as MemberRecord),
    notifier,
    '1:11',
    '6E2',
  );
  assert.equal(sent.length, 1, 'seul le profil élève rattaché est prévenu');
  assert.deepEqual(sent[0]?.to, ['m-Léo']);
  assert.equal(sent[0]?.pref, 'support');
  assert.match(sent[0]!.message.title, /Léo/);
});

test('suivi : niveau école et travail complémentaire côte à côte, sans changer la maîtrise école', () => {
  const { child } = setup();
  const state = emptySupport();
  state.enabled = true;
  state.focuses['c:maths:C1'] = {
    box: 3,
    due: '2026-11-19',
    difficulty: 2,
    seen: 4,
    right: 18,
    total: 20,
    last: '2026-11-12',
  };
  state.history = [0, 1, 2].map((i) => ({
    date: '2026-11-12',
    key: `k${i}`,
    subject: 'maths' as const,
    right: 4,
    total: 5,
    seconds: 300,
    hour: 18,
  }));
  const monitor = monitorOf(child, state, '2026-11-12', NOW);
  const c1 = monitor.skills.find((s) => s.key === 'c:maths:C1')!;
  assert.equal(c1.level, 1, 'le niveau école reste celui d’ÉcoleDirecte');
  assert.equal(c1.work?.modules, 4);
  assert.equal(c1.work?.success, 0.9);
  assert.equal(c1.status, 'progres', 'consolidée par le travail, mais pas acquise à l’école');
  assert.equal(monitor.skills.find((s) => s.key === 'c:francais:C2')?.status, 'reprendre');
  assert.equal(monitor.skills.find((s) => s.key === 'c:anglais:C3')?.status, 'acquise');
  assert.equal(monitor.skills[0]?.status, 'reprendre', 'les points à reprendre d’abord');
  assert.equal(monitor.days.length, 14);
  assert.equal(monitor.days.at(-1)?.modules, 3);
  assert.equal(monitor.fullDays, 1);
  assert.deepEqual(
    monitor.subjects.map((s) => s.subject),
    ['maths', 'francais', 'anglais'],
  );
});

test('audit : données périmées, l’audit attend la prochaine lecture fraîche', async () => {
  const { support, child, clock } = setup();
  const { notifier, sent } = fakeNotifier();
  support.setEnabled('1:11', true);
  clock.value = new Date('2026-11-12T09:00:00+01:00');
  const dashboard = { children: [child] } as unknown as Dashboard;
  let stale = true;
  const options = () => ({
    support,
    family: familyOf(kid('Léo')),
    notifier,
    ed: { dashboard: async () => ({ dashboard, stale }) },
    now: () => clock.value,
  });
  assert.equal(await runDailyAudit(options()), 0);
  assert.equal(support.pendingNotice('1:11'), null, 'aucun plan figé sur des données anciennes');
  stale = false;
  assert.equal(await runDailyAudit(options()), 1);
  assert.equal(sent.length, 1);
});

test('suivi : une moyenne absente reste absente, et celle des 30 jours ignore les vieilles notes', () => {
  const none = monitorOf({ notes: [] }, emptySupport(), '2026-11-12', NOW);
  assert.ok(
    none.skills.every((s) => s.average === null),
    'aucune note : pas de moyenne inventée',
  );
  assert.ok(none.subjects.every((s) => s.average === null));

  const lone = monitorOf({ notes: [note('ANGLAIS', '2026-11-05', 6)] }, emptySupport(), '2026-11-12', NOW);
  assert.equal(lone.skills.find((s) => s.key === 's:anglais')?.average, 6, 'la vraie note, pas 10/20');

  const old = monitorOf({ notes: [note('MATHS', '2026-09-20', 18)] }, emptySupport(), '2026-11-12', NOW);
  assert.equal(
    old.subjects.find((s) => s.subject === 'maths')?.average,
    null,
    'une note de septembre n’est pas sur 30 jours',
  );
  assert.equal(old.skills.find((s) => s.key === 's:maths')?.average, 18);
});

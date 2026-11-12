/**
 * Tests du soutien scolaire (V2, lot 1) : moteur pur et service serveur.
 *
 * Rôle : verrouiller les règles décidées par Julien (3 modules de 10 minutes par
 * jour au plus, maîtrise issue d'ÉcoleDirecte seulement, rien de comparé entre
 * enfants) et les garde-fous du service (correction côté serveur, exercices de
 * Claude validés, une seule correction par module).
 *
 * Fonctionnement : un faux rédacteur d'exercices remplace l'API Anthropic ; le
 * coffre est un dossier temporaire.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BOX_DAYS,
  focusesOf,
  levelOf,
  MAX_MODULES_PER_DAY,
  planDay,
  settle,
  subjectOf,
  summarize,
  type Focus,
  type FocusState,
  type ModuleRecord,
} from '../src/shared/support.ts';
import {
  ClaudeExerciseWriter,
  parseExercises,
  Support,
  SupportError,
  type Exercise,
  type ExerciseWriter,
} from '../src/server/support.ts';
import { Vault } from '../src/server/vault.ts';
import type { Note, Skill } from '../src/shared/types.ts';

const NOW = new Date('2026-11-12T08:00:00+01:00');
const TODAY = '2026-11-12';

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
const skill = (name: string, level: Skill['level'], competenceId = name): Skill => ({
  name,
  detail: '',
  level,
  competenceId,
});
const focus = (key: string, subject: Focus['subject'], mastery: number): Focus => ({
  key,
  subject,
  label: key,
  mastery,
  source: 'competence',
});

test('matières du périmètre et niveau de classe', () => {
  assert.equal(subjectOf('MATHEMATIQUES'), 'maths');
  assert.equal(subjectOf('Mathématiques'), 'maths');
  assert.equal(subjectOf('FRANCAIS'), 'francais');
  assert.equal(subjectOf('Lettres'), 'francais');
  assert.equal(subjectOf('ANGLAIS LV1'), 'anglais');
  assert.equal(subjectOf('HISTOIRE-GEOGRAPHIE'), null);
  assert.equal(subjectOf('ESPAGNOL LV2'), null);
  assert.equal(subjectOf(undefined), null);
  assert.equal(levelOf('6E2'), '6e');
  assert.equal(levelOf('5eme B'), '5e');
  assert.equal(levelOf('3ème'), '3e');
  assert.equal(levelOf('2NDE 4'), 'secondaire');
  assert.equal(levelOf(undefined), 'secondaire');
});

test('points à travailler : dernier niveau de chaque compétence, matières du périmètre seulement', () => {
  const focuses = focusesOf(
    {
      notes: [
        note('MATHS', '2026-10-01', 12, [skill('Résoudre une équation', 1, 'C1'), skill('Calculer', 4, 'C2')]),
        note('MATHS', '2026-11-05', 14, [skill('Résoudre une équation', 3, 'C1'), skill('Sans niveau', null, 'C3')]),
        note('HISTOIRE', '2026-11-05', 9, [skill('Situer dans le temps', 1, 'H1')]),
        note('ANGLAIS', '2026-11-04', 6),
      ],
    },
    NOW,
  );
  const byKey = new Map(focuses.map((f) => [f.key, f]));
  assert.equal(byKey.get('c:maths:C1')?.mastery, 2 / 3, 'le niveau le plus récent remplace l’ancien');
  assert.equal(byKey.get('c:maths:C2')?.mastery, 1);
  assert.ok(!byKey.has('c:maths:C3'), 'une compétence sans niveau ne compte pas');
  assert.ok(![...byKey.keys()].some((k) => k.includes('H1')), 'l’histoire est hors périmètre');
  assert.ok(byKey.has('s:maths'));
  assert.ok(!byKey.has('s:anglais'), 'une seule note ne suffit pas à juger une matière');
});

test('plan du jour : trois modules au plus, fragiles d’abord, matières variées, rien de maîtrisé', () => {
  const focuses = [
    focus('a', 'maths', 0),
    focus('b', 'maths', 0.1),
    focus('c', 'francais', 0.3),
    focus('d', 'anglais', 0.5),
    focus('e', 'maths', 1),
  ];
  const plan = planDay(focuses, { focuses: {} }, TODAY);
  assert.equal(plan.length, MAX_MODULES_PER_DAY);
  assert.deepEqual(
    plan.map((p) => p.focus.key),
    ['a', 'c', 'd'],
    'un deuxième module de maths attend que les autres matières aient eu leur tour',
  );
  assert.ok(plan.every((p) => p.reason === 'new'));
  assert.ok(!plan.some((p) => p.focus.key === 'e'), 'compétence très bien maîtrisée : pas de module');
  assert.equal(plan[0]?.difficulty, 1);
  assert.equal(plan[2]?.difficulty, 2);

  // Déjà fait aujourd'hui : le budget de 3 modules est partagé.
  assert.equal(planDay(focuses, { focuses: {} }, TODAY, [{ key: 'a' }, { key: 'c' }]).length, 1);
  assert.equal(planDay(focuses, { focuses: {} }, TODAY, [{ key: 'a' }, { key: 'c' }, { key: 'd' }]).length, 0);
  assert.ok(!planDay(focuses, { focuses: {} }, TODAY, [{ key: 'a' }]).some((p) => p.focus.key === 'a'));
});

test('révision espacée : un point reste en attente jusqu’à son échéance', () => {
  const state: FocusState = {
    box: 2,
    due: '2026-11-14',
    difficulty: 2,
    seen: 3,
    right: 12,
    total: 15,
    last: '2026-11-10',
  };
  const focuses = [focus('a', 'maths', 0.2)];
  assert.equal(planDay(focuses, { focuses: { a: state } }, '2026-11-13').length, 0);
  const due = planDay(focuses, { focuses: { a: state } }, '2026-11-14');
  assert.equal(due[0]?.reason, 'due');
  assert.equal(due[0]?.difficulty, 2);
  // Même un point maîtrisé revient quand sa révision arrive.
  assert.equal(planDay([focus('z', 'anglais', 1)], { focuses: { z: { ...state, due: TODAY } } }, TODAY).length, 1);
});

test('après un module : espacer et durcir, ou ramener tôt et alléger', () => {
  const f = focus('a', 'maths', 0.5);
  const first = settle(undefined, f, 5, 5, TODAY);
  assert.equal(first.box, 1);
  assert.equal(first.difficulty, 3, 'un sans-faute durcit (départ au niveau 2)');
  assert.equal(first.due, '2026-11-14', `${BOX_DAYS[1]} jours plus tard`);

  const steady = settle(first, f, 3, 5, TODAY);
  assert.equal(steady.box, 1, '60 % : même rythme');
  assert.equal(steady.difficulty, 3);

  const weak = settle(steady, f, 1, 5, TODAY);
  assert.equal(weak.box, 0);
  assert.equal(weak.difficulty, 2);
  assert.equal(weak.due, '2026-11-13', 'retour dès demain');
  assert.equal(weak.seen, 3);
  assert.equal(weak.total, 15);

  let state = first;
  for (let i = 0; i < 10; i++) state = settle(state, f, 5, 5, TODAY);
  assert.equal(state.box, BOX_DAYS.length - 1, 'la boîte est plafonnée');
  assert.equal(state.difficulty, 3);
  assert.equal(settle(undefined, focus('l', 'maths', 0), 0, 5, TODAY).difficulty, 1, 'jamais sous le niveau 1');
});

test('bilan sur quatorze jours : propre à l’élève, heure habituelle après trois modules', () => {
  const rec = (date: string, subject: ModuleRecord['subject'], right: number, hour = 18): ModuleRecord => ({
    date,
    key: 'k',
    subject,
    right,
    total: 5,
    seconds: 400,
    hour,
  });
  assert.equal(summarize([rec(TODAY, 'maths', 4)], TODAY).usualHour, null);
  const history = [
    rec('2026-10-01', 'maths', 1),
    rec('2026-11-10', 'maths', 4),
    rec('2026-11-11', 'maths', 5),
    rec(TODAY, 'anglais', 3),
  ];
  const s = summarize(history, TODAY);
  assert.equal(s.modules, 3, 'le module du 1er octobre sort de la fenêtre');
  assert.deepEqual(s.subjects, [
    { subject: 'maths', modules: 2, success: 9 / 10 },
    { subject: 'anglais', modules: 1, success: 3 / 5 },
  ]);
  assert.equal(s.usualHour, 18);
});

const valid5 = (): Exercise[] =>
  Array.from({ length: 5 }, (_, i) => ({
    q: `Question ${i}`,
    choices: ['A', 'B', 'C'],
    answer: 0,
    explain: 'Parce que.',
  }));
const asJson = (items: Exercise[]) => JSON.stringify(items);

test('exercices de Claude : validation stricte, bonne réponse conservée après mélange', () => {
  const parsed = parseExercises('```json\n' + asJson(valid5()) + '\n```');
  assert.equal(parsed.length, 5);
  for (const x of parsed) assert.equal(x.choices[x.answer], 'A', 'le mélange suit la bonne réponse');

  const bad = (mutate: (x: any[]) => void) => {
    const items: any[] = valid5();
    mutate(items);
    assert.throws(() => parseExercises(JSON.stringify(items)), /Exercices/);
  };
  assert.throws(() => parseExercises('pas du json'), /illisibles/);
  assert.throws(() => parseExercises('{"q":"x"}'), /invalides/);
  assert.throws(() => parseExercises(asJson(valid5().slice(0, 2))), /invalides/);
  bad((x) => (x[0].answer = 3));
  bad((x) => (x[0].answer = '0'));
  bad((x) => (x[0].choices = ['A', 'a', 'C']));
  bad((x) => (x[0].choices = ['A', 'B']));
  bad((x) => (x[0].choices = ['A', 'B', 'C', 'D', 'E']));
  bad((x) => (x[0].q = 'x'.repeat(201)));
  bad((x) => (x[0].choices = ['A', '', 'C']));
  bad((x) => (x[0].choices = ['A', 'B', 7]));
});

test('rédacteur Claude : aucune donnée personnelle envoyée, un seul nouvel essai', async () => {
  const calls: { system: string; user: string }[] = [];
  let attempts = 0;
  const writer = new ClaudeExerciseWriter({
    configured: true,
    async complete(system, user) {
      calls.push({ system, user });
      return ++attempts === 1 ? 'désolé' : asJson(valid5());
    },
  });
  const out = await writer.write({ subject: 'maths', label: 'Résoudre\nune équation', level: '6e', difficulty: 2 });
  assert.equal(out.length, 5);
  assert.equal(calls.length, 2);
  const sent = JSON.parse(calls[0]!.user);
  assert.deepEqual(Object.keys(sent).sort(), ['competence', 'difficulte', 'matiere', 'niveau']);
  assert.equal(sent.competence, 'Résoudre une équation');

  const failing = new ClaudeExerciseWriter({
    configured: true,
    async complete() {
      throw new Error('Génération indisponible.');
    },
  });
  await assert.rejects(
    () => failing.write({ subject: 'maths', label: 'x', level: '6e', difficulty: 1 }),
    /indisponible/,
  );
  assert.equal(new ClaudeExerciseWriter({ configured: false, complete: async () => '' }).available, false);
});

function setup(available = true) {
  const vaultDir = mkdtempSync(join(tmpdir(), 'o5g-support-'));
  const vault = new Vault(vaultDir);
  const clock = { value: new Date(NOW) };
  const log = { writes: 0 };
  const writer: ExerciseWriter = {
    get available() {
      return available;
    },
    async write() {
      log.writes++;
      return valid5().map((x) => ({ ...x, answer: 1, choices: ['x', 'bonne', 'y'] }));
    },
  };
  const support = new Support(vault, writer, () => clock.value);
  const child = {
    className: '6E2',
    notes: [
      note('MATHS', '2026-10-20', 8, [skill('Calculer avec des fractions', 1, 'C1')]),
      note('FRANCAIS', '2026-10-22', 10, [skill('Accorder le participe passé', 2, 'C2')]),
      note('ANGLAIS', '2026-10-25', 11, [skill('Comprendre un texte court', 2, 'C3')]),
      note('MATHS', '2026-11-05', 9),
    ],
  };
  return { vault, vaultDir, clock, log, support, child };
}

test('service : désactivé par défaut, activé par un parent, plan limité à trois modules', async () => {
  const { support, child } = setup();
  let status = support.status('1:11', child);
  assert.equal(status.enabled, false);
  assert.deepEqual(status.plan, []);
  await assert.rejects(
    () => support.start('1:11', child, 'c:maths:C1'),
    (e: unknown) => e instanceof SupportError && e.code === 403,
  );

  support.setEnabled('1:11', true);
  status = support.status('1:11', child);
  assert.equal(status.enabled, true);
  assert.equal(status.max, 3);
  assert.equal(status.minutes, 10);
  assert.equal(status.plan.length, 3);
  assert.deepEqual(new Set(status.plan.map((p) => p.subject)), new Set(['maths', 'francais', 'anglais']));
  assert.equal(support.status('1:12', child).enabled, false, 'chaque élève a son propre réglage');
});

test('service : la solution ne quitte pas le serveur, correction unique, mémoire conservée', async () => {
  const { support, child, vaultDir, log } = setup();
  support.setEnabled('1:11', true);
  const key = support.status('1:11', child).plan[0]!.key;

  const view = await support.start('1:11', child, key);
  assert.equal(view.items.length, 5);
  for (const item of view.items) assert.deepEqual(Object.keys(item), ['q', 'choices']);
  assert.ok(!/answer|explain|Parce que/.test(JSON.stringify(view)), 'aucune solution envoyée avant la réponse');
  const again = await support.start('1:11', child, key);
  assert.equal(again.id, view.id);
  assert.equal(log.writes, 1, 'rouvrir un module ne rappelle pas Claude');
  await assert.rejects(
    () => support.start('1:11', child, 'c:maths:inconnu'),
    (e: unknown) => e instanceof SupportError && e.code === 409,
  );

  assert.throws(
    () => support.answer('1:12', child, view.id, [1, 1, 1, 1, 1], 300),
    (e: unknown) => e instanceof SupportError && e.code === 404,
    'un autre élève ne corrige pas ce module',
  );
  assert.throws(() => support.answer('1:11', child, view.id, [1, 1], 300), /incomplètes/);

  const result = support.answer('1:11', child, view.id, [1, 1, 1, 0, 'x'], 420);
  assert.equal(result.right, 3);
  assert.equal(result.total, 5);
  assert.deepEqual(
    result.items.map((x) => x.correct),
    [true, true, true, false, false],
  );
  assert.equal(result.items[0]?.answer, 1);
  assert.equal(result.status.doneToday, 1);
  assert.ok(!result.status.plan.some((p) => p.key === key), 'le module fait quitte le plan du jour');
  assert.throws(() => support.answer('1:11', child, view.id, [1, 1, 1, 1, 1], 1), /déjà été corrigé/);

  // La mémoire survit à un redémarrage.
  const reloaded = new Support(new Vault(vaultDir), { available: true, write: async () => valid5() });
  const status = reloaded.status('1:11', child);
  assert.equal(status.enabled, true);
  assert.equal(status.doneToday, 1);
  assert.equal(status.summary.modules, 1);
  assert.equal(status.summary.usualHour, null);
});

test('service : jamais plus de trois modules par jour, reprise le lendemain avec révision espacée', async () => {
  const { support, child, clock } = setup();
  support.setEnabled('1:11', true);
  for (const p of support.status('1:11', child).plan) {
    const view = await support.start('1:11', child, p.key);
    support.answer('1:11', child, view.id, [1, 1, 1, 1, 1], 300);
  }
  const done = support.status('1:11', child);
  assert.equal(done.doneToday, 3);
  assert.deepEqual(done.plan, []);
  await assert.rejects(
    () => support.start('1:11', child, 'c:maths:C1'),
    (e: unknown) => e instanceof SupportError && e.code === 409,
  );

  // Demain : rien de ce qui vient d'être réussi (un sans-faute espace à 2 jours), seulement un point resté nouveau.
  clock.value = new Date('2026-11-13T08:00:00+01:00');
  const next = support.status('1:11', child);
  assert.equal(next.doneToday, 0);
  assert.deepEqual(
    next.plan.map((p) => [p.key, p.reason]),
    [['s:maths', 'new']],
  );
  clock.value = new Date('2026-11-14T08:00:00+01:00');
  const back = support.status('1:11', child);
  assert.equal(back.plan.filter((p) => p.reason === 'due').length, 3, 'les trois points reviennent à l’échéance');
  assert.equal(back.plan.length, 3);
});

test('service : sans clé Claude, rien n’est généré ; effacement d’un élève', async () => {
  const { support, child } = setup(false);
  support.setEnabled('1:11', true);
  const status = support.status('1:11', child);
  assert.equal(status.available, false);
  await assert.rejects(
    () => support.start('1:11', child, status.plan[0]!.key),
    (e: unknown) => e instanceof SupportError && e.code === 503,
  );
  support.forget('1:11');
  assert.equal(support.status('1:11', child).enabled, false);
});

test('service : un module de Claude invalide est refusé proprement', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'o5g-support-'));
  const support = new Support(
    new Vault(dir),
    {
      available: true,
      async write() {
        throw new Error('Exercices invalides.');
      },
    },
    () => NOW,
  );
  const { child } = setup();
  support.setEnabled('1:11', true);
  await assert.rejects(
    () => support.start('1:11', child, support.status('1:11', child).plan[0]!.key),
    (e: unknown) => e instanceof SupportError && e.code === 503 && /indisponibles/.test(e.message),
  );
});

test('service : un module ouvert plus tôt ne dépasse pas le budget du jour à la correction', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'o5g-support-'));
  const support = new Support(new Vault(dir), { available: true, write: async () => valid5() }, () => NOW);
  const child = {
    className: '6E2',
    notes: [
      note('MATHS', '2026-11-01', 8, [
        skill('Fractions', 1, 'C1'),
        skill('Équations', 2, 'C2'),
        skill('Géométrie', 2, 'C3'),
      ]),
      note('ANGLAIS', '2026-11-02', 12, [skill('Lire', 3, 'E1')]),
      note('FRANCAIS', '2026-11-03', 12, [skill('Accorder', 3, 'F1')]),
    ],
  };
  support.setEnabled('1:11', true);
  const first = support.status('1:11', child).plan.map((p) => p.key);
  assert.equal(first.length, 3);
  const views = [];
  for (const key of first) views.push(await support.start('1:11', child, key));
  support.answer('1:11', child, views[0]!.id, [0, 0, 0, 0, 0], 60);

  // Le plan a changé : un module qui n'était pas offert au départ apparaît.
  const later = support.status('1:11', child).plan.map((p) => p.key);
  const added = later.find((key) => !first.includes(key));
  assert.ok(added, 'un nouveau module est proposé après le premier');
  const extra = await support.start('1:11', child, added);

  support.answer('1:11', child, views[1]!.id, [0, 0, 0, 0, 0], 60);
  support.answer('1:11', child, views[2]!.id, [0, 0, 0, 0, 0], 60);
  assert.equal(support.status('1:11', child).doneToday, 3);
  assert.throws(
    () => support.answer('1:11', child, extra.id, [0, 0, 0, 0, 0], 60),
    (e: unknown) => e instanceof SupportError && e.code === 409,
    'le quatrième module du jour est refusé',
  );
  assert.equal(support.status('1:11', child).doneToday, 3);
});

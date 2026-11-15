/**
 * Page Compétences et fiches de travail : vue par matière, profil de l'élève, recueil des programmes,
 * rédaction (validation, secours, budget, confidentialité).
 *
 * Fonctionnement : horloge simulée, rédacteur factice qui garde les requêtes reçues, coffre temporaire.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CURRICULUM, curriculumFor } from '../src/shared/curriculum.ts';
import { overviewOf, profileOf } from '../src/shared/skills.ts';
import { emptySupport, focusesOf } from '../src/shared/support.ts';
import { parseSheet, Sheets, sheetView, type SheetRequest, type SheetWriter } from '../src/server/sheets.ts';
import { Support, type ExerciseWriter } from '../src/server/support.ts';
import { Vault } from '../src/server/vault.ts';
import type { Note, Skill } from '../src/shared/types.ts';

const NOW = new Date('2026-11-12T08:00:00+01:00');
const note = (subject: string, date: string, value = 12, skills: Skill[] = []): Note => ({
  subject,
  subjectId: `${subject}:`,
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

const child = {
  className: '5E1',
  notes: [
    note('MATHS', '2026-10-20', 12, [skill('Comparer des fractions', 3, 'F1')]),
    note('MATHS', '2026-11-08', 6, [skill('Comparer des fractions', 1, 'F1'), skill('Résoudre une équation', 2, 'E1')]),
    note('HISTOIRE-GEOGRAPHIE', '2026-11-02', 15, [skill('Se repérer dans le temps', 4, 'H1')]),
    note('ANGLAIS', '2026-11-03', 11, []),
  ],
};

const GOOD = {
  objectif: 'Comparer deux fractions sans te tromper.',
  rappel: ['On met au même dénominateur.', 'On compare ensuite les numérateurs.'],
  guide: { consigne: 'Compare 3/4 et 2/3.', indice: 'Dénominateur 12.', corrige: '9/12 > 8/12' },
  autonomes: [
    { consigne: 'Compare 5/6 et 3/4.', indice: 'Dénominateur 12.', corrige: '10/12 > 9/12' },
    { consigne: 'Range 1/2, 2/3, 3/5.', indice: 'Dénominateur 30.', corrige: '15/30 < 18/30 < 20/30' },
  ],
  astuces: ['Dessine des barres.'],
  encouragement: 'Tu y es presque.',
};

test('la vue d’ensemble couvre toutes les matières et reprend les plus faibles d’abord', () => {
  const overview = overviewOf(child, emptySupport(), NOW);
  const labels = overview.subjects.map((s) => s.label);
  assert.ok(labels.includes('HISTOIRE-GEOGRAPHIE'), 'une matière hors soutien apparaît aussi');
  assert.equal(overview.subjects[0]?.label, 'MATHS', 'la matière avec le plus de reprises passe en premier');
  const maths = overview.subjects.find((s) => s.label === 'MATHS')!;
  assert.equal(maths.skills[0]?.label, 'Comparer des fractions');
  assert.equal(maths.skills[0]?.level, 1, 'le dernier niveau compte');
  assert.equal(maths.skills[0]?.progress, 'down');
  assert.equal(maths.skills[0]?.sheet, true);
  const hist = overview.subjects.find((s) => s.label === 'HISTOIRE-GEOGRAPHIE')!;
  assert.equal(hist.skills[0]?.status, 'acquise');
  assert.equal(hist.skills[0]?.sheet, false, 'pas de fiche hors maths, français, anglais');
  assert.equal(overview.totals.reprendre, 2);
  assert.equal(overview.totals.acquise, 1);
});

test('le travail fait ici consolide une compétence à reprendre', () => {
  const support = emptySupport();
  support.focuses['c:maths:F1'] = {
    box: 3,
    due: '2026-11-20',
    difficulty: 2,
    seen: 4,
    right: 16,
    total: 20,
    last: '2026-11-11',
  };
  const maths = overviewOf(child, support, NOW).subjects.find((s) => s.label === 'MATHS')!;
  const fractions = maths.skills.find((s) => s.label === 'Comparer des fractions');
  assert.equal(
    fractions?.status,
    'progres',
    '4 modules à 80 % : la compétence passe de « à reprendre » à « en cours »',
  );
  assert.deepEqual(fractions?.work, { modules: 4, right: 16, total: 20 });
  // Sans ce travail, la même compétence reste à reprendre.
  const bare = overviewOf(child, emptySupport(), NOW).subjects.find((s) => s.label === 'MATHS')!;
  assert.equal(bare.skills.find((s) => s.label === 'Comparer des fractions')?.status, 'reprendre');
});

test('le profil reste chiffré, sans nom, et suit la maîtrise', () => {
  const focus = focusesOf(child, NOW).find((f) => f.key === 'c:maths:F1')!;
  const support = emptySupport();
  support.aids = ['schemas', 'inconnue'];
  const profile = profileOf(child, support, focus, NOW);
  assert.equal(profile.level, '5e');
  assert.equal(profile.tone, 'ludique');
  assert.equal(profile.mastery, 'reprise');
  assert.deepEqual(profile.aids, ['schemas'], 'les aides inconnues sont écartées');
  assert.ok(!JSON.stringify(profile).match(/Léo|F1/));
  const strong = profileOf({ ...child, className: '3E2' }, support, { ...focus, mastery: 1 }, NOW);
  assert.equal(strong.mastery, 'approfondissement');
  assert.equal(strong.tone, 'sobre');
});

test('le recueil retrouve la notion d’après l’intitulé, sinon une entrée générale', () => {
  assert.equal(curriculumFor('maths', 'Comparer des fractions').id, 'maths-fractions');
  assert.equal(curriculumFor('maths', 'Résoudre une équation du premier degré').id, 'maths-litteral');
  assert.equal(curriculumFor('francais', 'Accorder le participe passé').id, 'fr-grammaire');
  assert.equal(curriculumFor('anglais', 'Écrire un court message').id, 'en-ecrire');
  assert.equal(curriculumFor('maths', 'Zzz').id, 'maths-problemes');
  for (const e of CURRICULUM) {
    assert.ok(e.erreurs.length >= 2 && e.appuis.length >= 2 && e.attendu && e.prerequis, e.id);
  }
});

test('la sortie de Claude est validée strictement', () => {
  assert.equal(parseSheet('```json\n' + JSON.stringify(GOOD) + '\n```').autonomes.length, 2);
  assert.throws(() => parseSheet('pas du json'), /illisible/);
  assert.throws(() => parseSheet(JSON.stringify({ ...GOOD, autonomes: [GOOD.autonomes[0]] })), /invalide/);
  assert.throws(() => parseSheet(JSON.stringify({ ...GOOD, objectif: 'x'.repeat(400) })), /invalide/);
  assert.throws(() => parseSheet(JSON.stringify({ ...GOOD, rappel: ['seul'] })), /invalide/);
});

function setup(write: SheetWriter['write'], available = true) {
  const dir = mkdtempSync(join(tmpdir(), 'o5g-sheets-'));
  const clock = { value: new Date(NOW) };
  const requests: SheetRequest[] = [];
  const writer: SheetWriter = {
    available,
    async write(request) {
      requests.push(request);
      return write(request);
    },
  };
  const exercises: ExerciseWriter = { available, write: async () => [] };
  const vault = new Vault(dir);
  const sheets = new Sheets(vault, writer, () => clock.value);
  const support = new Support(vault, exercises, () => clock.value);
  return { sheets, support, clock, requests };
}

test('une fiche est rédigée une fois, adaptée au profil, sans donnée personnelle', async () => {
  const { sheets, requests, support } = setup(async () => GOOD);
  support.setAids('1:11', ['schemas']);
  const a = await sheets.sheet('1:11', child, support.state('1:11'), 'c:maths:F1');
  const b = await sheets.sheet('1:11', child, support.state('1:11'), 'c:maths:F1');
  assert.equal(a.via, 'claude');
  assert.equal(requests.length, 1, 'la deuxième lecture ne rappelle pas Claude');
  assert.deepEqual(a.content, b.content);
  const sent = JSON.stringify(requests[0]);
  assert.ok(sent.includes('"mastery":"reprise"') || sent.includes('reprise'));
  assert.ok(requests[0]!.profile.aids.includes('schemas'));
  assert.ok(!sent.includes('1:11'), 'aucun identifiant d’élève n’est transmis');
  const view = sheetView(a) as unknown as Record<string, unknown>;
  assert.ok(!('profile' in view) && !('fingerprint' in view), 'le navigateur ne reçoit pas le profil');
});

test('réécriture à la demande limitée, et nouvelle fiche le lendemain', async () => {
  const { sheets, requests, support, clock } = setup(async () => GOOD);
  const call = (refresh = false) => sheets.sheet('1:11', child, support.state('1:11'), 'c:maths:F1', refresh);
  await call();
  await call(true);
  assert.equal(requests.length, 1, 'pas de réécriture dans les dix minutes');
  clock.value = new Date(NOW.getTime() + 11 * 60000);
  await call(true);
  assert.equal(requests.length, 2);
  clock.value = new Date(NOW.getTime() + 26 * 3600000);
  await call();
  assert.equal(requests.length, 3, 'le lendemain, la fiche est refaite');
});

test('le profil qui change réécrit la fiche après une heure', async () => {
  const { sheets, requests, support, clock } = setup(async () => GOOD);
  const call = () => sheets.sheet('1:11', child, support.state('1:11'), 'c:maths:F1');
  await call();
  support.setAids('1:11', ['defis']);
  await call();
  assert.equal(requests.length, 1, 'trop tôt pour réécrire');
  clock.value = new Date(NOW.getTime() + 61 * 60000);
  await call();
  assert.equal(requests.length, 2);
});

test('sans clé ou si Claude échoue, une fiche de secours reste utilisable', async () => {
  const off = setup(async () => GOOD, false);
  const a = await off.sheets.sheet('1:11', child, off.support.state('1:11'), 'c:maths:F1');
  assert.equal(a.via, 'secours');
  assert.equal(off.requests.length, 0);
  assert.ok(a.content.autonomes.length >= 2 && a.content.rappel.length >= 2);
  const broken = setup(async () => {
    throw new Error('API indisponible');
  });
  const b = await broken.sheets
    .sheet('1:11', child, broken.support.state('1:11'), 'c:francais:inconnu')
    .catch((e: Error) => e);
  assert.ok(b instanceof Error, 'une compétence inconnue est refusée');
  const c = await broken.sheets.sheet('1:11', child, broken.support.state('1:11'), 's:maths');
  assert.equal(c.via, 'secours');
});

test('au-delà de douze rédactions par jour, la fiche existante est conservée', async () => {
  const { sheets, requests, support, clock } = setup(async () => GOOD);
  const keys = ['c:maths:F1', 'c:maths:E1', 's:maths', 's:francais', 's:anglais'];
  for (let i = 0; i < 13; i++) {
    clock.value = new Date(NOW.getTime() + i * 11 * 60000);
    await sheets.sheet('1:11', child, support.state('1:11'), keys[i % keys.length]!, true);
  }
  assert.ok(requests.length <= 12);
});

test('une compétence inconnue ou une clé invalide est refusée', async () => {
  const { sheets, support } = setup(async () => GOOD);
  await assert.rejects(sheets.sheet('1:11', child, support.state('1:11'), 'c:maths:NOPE'), /plus suivie/);
  await assert.rejects(sheets.sheet('1:11', child, support.state('1:11'), 42), /inconnue/);
});

test('des fiches demandées en même temps sont toutes enregistrées', async () => {
  const { sheets, support } = setup(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return GOOD;
  });
  const keys = ['s:maths', 's:francais', 's:anglais'];
  await Promise.all(keys.map((k) => sheets.sheet('1:11', child, support.state('1:11'), k)));
  assert.deepEqual(
    sheets
      .existing('1:11')
      .map((s) => s.key)
      .sort(),
    keys.slice().sort(),
  );
});

test('le budget du jour est réservé avant d’attendre Claude', async () => {
  const { sheets, support, requests, clock } = setup(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return GOOD;
  });
  for (let i = 0; i < 11; i++) {
    clock.value = new Date(NOW.getTime() + i * 11 * 60000);
    await sheets.sheet('1:11', child, support.state('1:11'), 'c:maths:F1', true);
  }
  assert.equal(requests.length, 11);
  await Promise.all(
    ['s:maths', 's:francais', 's:anglais'].map((k) => sheets.sheet('1:11', child, support.state('1:11'), k)),
  );
  assert.equal(requests.length, 12, 'une seule demande de plus : le plafond est de 12');
});

test('le recueil choisit la notion précise plutôt qu’un mot générique', () => {
  assert.equal(curriculumFor('maths', 'Calculer avec des fractions').id, 'maths-fractions');
  assert.equal(curriculumFor('maths', 'Calculer le volume d’une pyramide').id, 'maths-espace');
  assert.equal(curriculumFor('maths', 'Calcul numérique : priorités opératoires').id, 'maths-calcul');
});

test('la formule du volume est juste pour chaque solide', () => {
  const espace = CURRICULUM.find((e) => e.id === 'maths-espace')!;
  const tips = espace.appuis.join(' ');
  assert.match(tips, /pyramide et cône : un tiers/i);
  assert.doesNotMatch(tips, /^Volume = aire de la base × hauteur\.$/m);
});

test('la moyenne du profil ne compte que les 30 derniers jours', () => {
  const mixed = {
    className: '5E1',
    notes: [note('MATHS', '2026-11-05', 18), note('MATHS', '2026-02-10', 2), note('MATHS', '2026-02-20', 2)],
  };
  const focus = focusesOf(mixed, NOW).find((f) => f.key === 's:maths')!;
  assert.equal(profileOf(mixed, emptySupport(), focus, NOW).average, 18);
});

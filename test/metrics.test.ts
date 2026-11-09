/**
 * Tests des calculs sur les notes (`src/shared/metrics.ts`) et de leur
 * normalisation depuis ÉcoleDirecte (`normalizeNotes`, `number`).
 *
 * Rôle : verrouiller les règles de calcul affichées aux familles. Sont couverts :
 * barèmes et coefficients (un zéro compte, une absence ou un coefficient nul
 * non), tendance sur deux fenêtres, notes futures, écart à la classe sur les
 * seules évaluations appariées, réglages de masquage de l'établissement,
 * regroupement et résolution des matières et sous-matières, reconnaissance des
 * classes du secondaire, couleurs, photos et prochain jour ouvré.
 *
 * Fonctionnement : fonctions pures appelées avec des notes construites à la
 * main et des dates fixes ; aucun mock n'est nécessaire.
 *
 * Points d'attention : la liste de libellés de classe de `isSecondary` reprend
 * des cas réels. Toute modification de l'expression régulière doit préserver
 * l'ensemble de ces exemples.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gradeBand,
  isSecondary,
  mean,
  metrics,
  nextSchoolDay,
  photoUrl,
  subjectGroups,
  toTwenty,
  valid,
} from '../src/shared/metrics.ts';
import { normalizeNotes, number } from '../src/server/ecoledirecte.ts';
import type { Gradable } from '../src/shared/types.ts';

const n = (value: number | null, outOf = 20, coefficient = 1, date = '2026-11-01'): Gradable => ({
  value,
  outOf,
  coefficient,
  date,
  excluded: false,
});

test('barèmes et coefficients, zéro inclus, absences et coef zéro exclus', () => {
  assert.equal(mean([n(8, 10, 2), n(10, 20, 1)]), 14);
  assert.equal(mean([n(0), n(20)]), 10);
  assert.equal(mean([n(null), n(12, 0), n(10, 20, 0)]), null);
  assert.equal(valid({ ...n(20), excluded: true }), false);
});

test('tendance sur deux fenêtres distinctes et comparaison appariée', () => {
  const result = metrics(
    [{ ...n(16), classAverage: 12 }, { ...n(10, 20, 1, '2026-09-25'), classAverage: null }, n(20)],
    new Date('2026-11-07T12:00:00Z'),
    30,
  );
  assert.equal(result.trend, 8);
  assert.equal(result.gap, 4);
  assert.equal(result.pairedCount, 1);
  assert.equal(metrics([n(12)], new Date('2026-11-07')).trend, null);
});

test('exclusion des notes futures de la tendance', () => {
  const r = metrics([n(20, 20, 1, '2030-01-01'), n(10, 20, 1, '2026-09-25')], new Date('2026-11-07'));
  assert.equal(r.trend, null);
  assert.equal(r.recentCount, 0);
});

test('valeurs françaises et absences non converties en zéro', () => {
  assert.equal(number('12,50'), 12.5);
  assert.equal(number('ABS'), null);
  assert.equal(number(''), null);
  assert.equal(number('12foo'), null);
  assert.equal(number('0'), 0);
  const r = normalizeNotes({
    notes: [
      { id: 1, valeur: 'ABS', noteSur: '20', coef: '0', libelleMatiere: 'Maths' },
      { id: 2, valeur: '8', noteSur: '10', coef: '2', nonSignificatif: true },
    ],
  });
  assert.equal(r.notes[0]?.value, null);
  assert.equal(r.notes[0]?.coefficient, 0);
  assert.equal(r.notes[1]?.excluded, true);
});

test('paramètres de masquage et absence de données', () => {
  const r = normalizeNotes({
    parametrage: { affichageNote: false, affichageMoyenne: false, moyenneClasse: false },
    notes: [{ valeur: '20' }],
    periodes: [{ codePeriode: 'A1', ensembleMatieres: { moyenneGenerale: '18', moyenneClasse: '12' } }],
  });
  assert.equal(r.notes.length, 0);
  assert.equal(r.periods[0]?.average, null);
  assert.equal(r.periods[0]?.classAverage, null);
  assert.deepEqual(normalizeNotes().notes, []);
  assert.equal(metrics([]).average, null);
});

test('regroupement par code matière et sous-matière', () => {
  assert.equal(
    subjectGroups([
      { subjectId: 'A', subject: 'Maths' },
      { subjectId: 'A', subject: 'Mathématiques' },
      { subjectId: 'B', subject: 'Maths' },
    ]).length,
    2,
  );
});

test('collège et lycée uniquement, classes réelles et variantes usuelles', () => {
  for (const label of [
    'CINQUIEME C',
    'TROISIEME B',
    'TERMINALE B',
    '6e',
    '4ème A',
    '2de 3',
    '1ère G',
    'Tle B',
    'Seconde',
    'Première',
  ])
    assert.equal(isSecondary(label), true, label);
  for (const label of [
    'COURS ELEMENTAIRE 2° AN 2',
    'MATERNELLE 3 MG',
    'CM2',
    'CE1',
    'CP',
    'Grande section',
    'BTS 1',
    '',
  ])
    assert.equal(isSecondary(label), false, label);
});

test('couleurs selon le barème, seuils et valeurs non numériques', () => {
  assert.equal(gradeBand(n(7, 10)), 'good');
  assert.equal(gradeBand(n(5, 10)), 'average');
  assert.equal(gradeBand(n(9.99)), 'poor');
  assert.equal(gradeBand(n(13.99)), 'average');
  assert.equal(gradeBand(n(14)), 'good');
  assert.equal(gradeBand(n(0)), 'poor');
  assert.equal(gradeBand(n(null)), 'neutral');
  assert.equal(gradeBand(n(2, 0)), 'neutral');
  assert.equal(gradeBand({ ...n(18), excluded: true }), 'neutral');
});

test('photos HTTPS ÉcoleDirecte seulement', () => {
  assert.equal(
    photoUrl('//doc1.ecoledirecte.com/PhotoEleves/test.jpg'),
    'https://doc1.ecoledirecte.com/PhotoEleves/test.jpg',
  );
  for (const url of [
    'javascript:alert(1)',
    'https://ecoledirecte.com.evil.test/a.jpg',
    'http://doc1.ecoledirecte.com/a.jpg',
    'https://user:secret@ecoledirecte.com/a.jpg',
    null,
  ])
    assert.equal(photoUrl(url), null);
});

test('conversion sur 20 des notes et moyennes, sans inventer les valeurs absentes', () => {
  assert.equal(toTwenty(7.5, 10), 15);
  assert.equal(toTwenty(4.67, 5), 18.68);
  assert.equal(toTwenty(0, 20), 0);
  assert.equal(toTwenty(15, 20), 15);
  const invalid: [unknown, unknown][] = [
    [null, 20],
    [12, 0],
    [12, null],
    ['ABS', 20],
    [12, -1],
    [NaN, 20],
  ];
  for (const [v, b] of invalid) assert.equal(toTwenty(v as number, b as number), null);
});

test('prochain jour de semaine en heure de Paris, vendredi et weekend vers lundi', () => {
  for (const [input, expected] of [
    ['2026-11-05T12:00:00Z', '2026-11-06'],
    ['2026-11-06T12:00:00Z', '2026-11-09'],
    ['2026-11-07T12:00:00Z', '2026-11-09'],
    ['2026-11-08T12:00:00Z', '2026-11-09'],
    ['2026-11-09T12:00:00Z', '2026-11-10'],
    ['2026-11-08T23:30:00Z', '2026-11-10'],
  ] as const)
    assert.equal(nextSchoolDay(new Date(input)), expected);
});

test('matière parente et sous-matière résolues par code et période', () => {
  const periodes = [
    {
      codePeriode: 'T1',
      ensembleMatieres: {
        disciplines: [
          { codeMatiere: 'ANG', codeSousMatiere: '', discipline: 'ANGLAIS LV1', sousMatiere: false },
          { codeMatiere: 'ANG', codeSousMatiere: 'O', discipline: 'Oral', sousMatiere: true },
          { codeMatiere: 'ITA', codeSousMatiere: '', discipline: 'ITALIEN LV2', sousMatiere: false },
          { codeMatiere: 'ITA', codeSousMatiere: 'O', discipline: 'Oral', sousMatiere: true },
        ],
      },
    },
  ];
  const notes = normalizeNotes({
    periodes,
    notes: [
      { codePeriode: 'T1', codeMatiere: 'ANG', codeSousMatiere: 'O', libelleMatiere: 'Oral' },
      { codePeriode: 'T1', codeMatiere: 'ITA', codeSousMatiere: 'O', libelleMatiere: 'Oral' },
    ],
  }).notes;
  assert.equal(notes[0]?.subject, 'ANGLAIS LV1 · Oral');
  assert.equal(notes[1]?.subject, 'ITALIEN LV2 · Oral');
  assert.notEqual(notes[0]?.subjectId, notes[1]?.subjectId);
});

test('sous-matière sans référentiel : code parent explicite, aucune matière inventée', () => {
  const notes = normalizeNotes({
    notes: [
      { codeMatiere: 'XYZ', codeSousMatiere: 'E', libelleMatiere: 'Ecrit' },
      { codeMatiere: 'MAT', libelleMatiere: 'Mathématiques' },
    ],
  }).notes;
  assert.equal(notes[0]?.subject, 'XYZ · Ecrit');
  assert.equal(notes[1]?.subject, 'Mathématiques');
});

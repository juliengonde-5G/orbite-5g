/**
 * Tests de l'aperçu « 7 derniers jours » (`weeklyNotes` dans `src/shared/metrics.ts`).
 *
 * Rôle : vérifier que la semaine couvre aujourd'hui et les six jours précédents
 * (bornes incluses), que seules les trois notes les plus récentes sont gardées
 * pour l'aperçu, avec le total exact pour le badge, et que les notes futures ou
 * non chiffrées sont écartées.
 *
 * Fonctionnement : appels directs avec des dates fixes, dont un instant proche
 * de minuit où la date UTC diffère de la date à Paris.
 *
 * Points d'attention : ce dernier cas protège contre un retour à
 * `toISOString()`, qui afficherait la mauvaise semaine en soirée.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { weeklyNotes } from '../src/shared/metrics.ts';

const note = (date: string, value: number | null = 12) => ({ date, value, outOf: 20, coefficient: 1 });

test('semaine inclusive J à J-6, trois plus récentes, sans notes futures ni non chiffrées', () => {
  const result = weeklyNotes(
    [
      note('2026-11-01'),
      note('2026-10-31'),
      note('2026-11-07'),
      note('2026-11-06'),
      note('2026-11-05'),
      note('2026-11-08'),
      note('2026-11-07', null),
    ],
    new Date('2026-11-07T12:00:00Z'),
  );
  assert.equal(result.total, 4);
  assert.deepEqual(
    result.notes.map((n) => n.date),
    ['2026-11-07', '2026-11-06', '2026-11-05'],
  );
  assert.equal(result.start, '2026-11-01');
});

test('jour courant calculé en heure de Paris, même à la frontière UTC', () => {
  const result = weeklyNotes([note('2026-11-08')], new Date('2026-11-07T23:30:00Z'));
  assert.equal(result.end, '2026-11-08');
  assert.equal(result.notes.length, 1);
  assert.equal(weeklyNotes([], new Date('2026-11-07')).total, 0);
});

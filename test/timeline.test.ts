/**
 * Tests de la courbe d'évolution (`gradeTimeline` dans `src/shared/metrics.ts`).
 *
 * Rôle : vérifier les trois séries du graphique détaillé. Les moyennes cumulées
 * de l'élève et de la classe doivent évoluer après chaque évaluation, avec
 * barèmes ramenés sur 20, coefficients et notes d'un même jour regroupées. La
 * tendance glissante ne doit inclure ni notes futures ni notes hors fenêtre, et
 * n'apparaît qu'avec au moins deux notes.
 *
 * Fonctionnement : notes construites par `note()` (sur 20, coefficient 1 par
 * défaut, surchargeables), comparaisons des points renvoyés.
 *
 * Points d'attention : les dates sont des jours civils ; les fenêtres sont
 * calculées jusqu'à la fin de chaque jour, d'où les cas en limite de fenêtre.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { gradeTimeline } from '../src/shared/metrics.ts';
import type { Gradable } from '../src/shared/types.ts';

const note = (date: string, value: number, extra: Partial<Gradable> = {}): Gradable => ({
  date,
  value,
  outOf: 20,
  coefficient: 1,
  ...extra,
});

test('courbes : normalisation, coefficients, notes du même jour et classe manquante', () => {
  const p = gradeTimeline([
    note('2026-10-01', 8, { outOf: 10, classAverage: 6 }),
    note('2026-10-01', 10, { coefficient: 3 }),
    note('2026-10-02', 14),
  ]);
  assert.equal(p.length, 2);
  assert.equal(p[0]?.average, 11.5);
  assert.equal(p[0]?.classAverage, 12);
  assert.equal(p[1]?.classAverage, 12);
  assert.equal(p[1]?.average, 12);
  assert.equal(p[0]?.notes.length, 2);
});

test('tendance glissante : ne comprend ni futur ni notes hors fenêtre ; deux notes minimum', () => {
  const p = gradeTimeline(
    [
      note('2026-09-01', 0),
      note('2026-10-01', 10),
      note('2026-10-10', 20),
      note('2026-10-11', 1, { excluded: true }),
      note('invalid', 2),
    ],
    14,
  );
  assert.equal(p.length, 3);
  assert.equal(p[0]?.trend, null);
  assert.equal(p[1]?.trend, null);
  assert.equal(p[2]?.trend, 15);
  assert.equal(p[2]?.count, 2);
});

test('moyennes cumulées élève et classe après chaque nouvelle évaluation', () => {
  const p = gradeTimeline([
    note('2026-10-01', 20, { classAverage: 18 }),
    note('2026-10-02', 10, { coefficient: 3, classAverage: 12 }),
    note('2026-10-03', 15),
  ]);
  assert.equal(p[0]?.average, 20);
  assert.equal(p[1]?.average, 12.5);
  assert.equal(p[2]?.average, 13);
  assert.equal(p[0]?.classAverage, 18);
  assert.equal(p[1]?.classAverage, 13.5);
  assert.equal(p[2]?.classAverage, 13.5);
});

/**
 * Cartable : jour à préparer et liste du sac (fonctions pures).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bagDate, bagItems, defaultItems, emptyKit, subjectKey } from '../src/shared/bag.ts';
import { normalizeTimetable, frenchDate } from '../src/server/ecoledirecte.ts';
import type { Course } from '../src/shared/types.ts';

const course = (subject: string, extra: Partial<Course> = {}): Course => ({
  id: subject,
  date: '2026-11-10',
  start: '08:00',
  end: '08:55',
  subject,
  code: '',
  room: '',
  teacher: '',
  kind: 'cours',
  cancelled: false,
  modified: false,
  exempted: false,
  ...extra,
});

test('jour à préparer : aujourd’hui avant 16 h, sinon le jour de classe suivant', () => {
  assert.deepEqual(bagDate(new Date('2026-11-10T06:30:00Z')), { date: '2026-11-10', focus: 'today' });
  assert.deepEqual(bagDate(new Date('2026-11-10T17:30:00Z')), { date: '2026-11-11', focus: 'next' });
  assert.deepEqual(bagDate(new Date('2026-11-13T18:00:00Z')), { date: '2026-11-16', focus: 'next' }, 'vendredi soir');
  assert.deepEqual(bagDate(new Date('2026-11-14T09:00:00Z')), { date: '2026-11-16', focus: 'next' }, 'samedi');
});

test('liste du sac : matériel par matière, doublons, annulations, dispense, permanence, pièces jointes', () => {
  assert.equal(subjectKey('Éd. physique & sport.'), 'ED PHYSIQUE SPORT');
  assert.deepEqual(defaultItems('ED.PHYSIQUE & SPORT.'), ['Tenue de sport', 'Baskets', 'Gourde']);
  assert.deepEqual(defaultItems('Option théâtre'), ['Affaires de option théâtre']);
  const items = bagItems(
    [
      course('MATHEMATIQUES'),
      course('PHYSIQUE-CHIMIE'),
      course('MATHEMATIQUES'),
      course('TECHNOLOGIE', { cancelled: true }),
      course('ED.PHYSIQUE & SPORT.', { exempted: true }),
      course('ETUDE', { kind: 'permanence' }),
    ],
    [
      {
        id: '2026-11-10:1',
        dueDate: '2026-11-10',
        subject: 'FRANCAIS',
        text: '',
        status: 'pending',
        exam: false,
        documents: ['Fiche.pdf'],
      },
    ],
    emptyKit(),
  );
  const labels = items.map((i) => i.label);
  assert.deepEqual(labels, [
    'Cahier de maths',
    'Calculatrice',
    'Règle, équerre et compas',
    'Cahier de physique-chimie',
    'Fiche.pdf',
    'Trousse complète',
    'Agenda',
    'Carnet de correspondance',
  ]);
  assert.equal(new Set(items.map((i) => i.id)).size, items.length);
});

test('emploi du temps ÉcoleDirecte et dates françaises', () => {
  const courses = normalizeTimetable([
    { id: 2, matiere: 'ANGLAIS LV1', start_date: '2026-11-10 10:00', end_date: '2026-11-10 10:55', isAnnule: true },
    {
      id: 1,
      text: 'MATHEMATIQUES',
      start_date: '2026-11-10 08:00',
      end_date: '2026-11-10 08:55',
      typeCours: 'COURS',
      dispense: 1,
    },
    { id: 3, start_date: 'n/a' },
    null,
  ]);
  assert.deepEqual(
    courses.map((c) => [c.start, c.subject, c.cancelled, c.exempted, c.kind]),
    [
      ['08:00', 'MATHEMATIQUES', false, true, 'cours'],
      ['10:00', 'ANGLAIS LV1', true, false, 'cours'],
    ],
  );
  assert.equal(frenchDate('05/11/2026'), '2026-11-05');
  assert.equal(frenchDate('2026-11-05'), null);
});

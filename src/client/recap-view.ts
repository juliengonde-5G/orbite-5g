/**
 * Récap de la semaine (parents) : pour chaque enfant, séparément et sans classement,
 * ce qui s'est passé ces sept derniers jours et ce qui arrive la semaine suivante.
 * La notification du dimanche soir ouvre cet écran.
 */
import { h, icon } from './dom.ts';
import { capitalize, longDay, relativeDay, shortDay, signed, subjectLabel } from './format.ts';
import { lifeOf } from './life-view.ts';
import { state } from './state.ts';
import { accent, emptyState, noteRow, sky, type Actions } from './views.ts';
import { metrics, parisDate } from '../shared/metrics.ts';
import type { Child } from '../shared/types.ts';

const DAY = 86400000;
const shift = (date: string, days: number) =>
  new Date(Date.parse(date + 'T12:00:00Z') + days * DAY).toISOString().slice(0, 10);

function childRecap(child: Child, actions: Actions, from: string, today: string): HTMLElement {
  const notes = child.notes
    .filter((n) => (n.date ?? '') >= from && (n.date ?? '') <= today)
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  const trend = metrics(child.notes).trend;
  const life = lifeOf(child.id, actions);
  const events = (life?.events ?? []).filter((e) => (e.date ?? '') >= from && (e.date ?? '') <= today);
  const hw = state.homework.get(child.id);
  if (!hw) actions.loadHomework(child.id);
  const until = shift(today, 7);
  const coming = (hw?.items ?? []).filter((t) => t.dueDate > today && t.dueDate <= until);
  const exams = coming.filter((t) => t.exam);
  const sanctions = events.filter((e) => e.kind === 'punition' || e.kind === 'sanction').length;
  const absences = events.filter((e) => e.kind === 'absence' || e.kind === 'retard').length;
  const cheers = events.filter((e) => e.kind === 'encouragement').length;
  return h(
    'section.block.recap-child',
    { style: accent(child.id) },
    h(
      'header.recap-head',
      h('h2', child.name),
      h('span', child.className),
      trend !== null &&
        h(
          `span.fact.trend-${Math.abs(trend) < 0.05 ? 'flat' : trend > 0 ? 'up' : 'down'}`,
          { title: 'Évolution de ses propres résultats' },
          signed(trend),
        ),
    ),
    h(
      'dl.recap-tiles',
      h('div', h('dt', 'Notes'), h('dd', String(notes.length))),
      h('div', h('dt', 'Devoirs à venir'), h('dd', hw?.loaded ? String(coming.length) : '…')),
      h('div', h('dt', 'Contrôles'), h('dd', hw?.loaded ? String(exams.length) : '…')),
      h(
        'div',
        h('dt', 'Vie scolaire'),
        h('dd', life ? String(events.length) : '…'),
        life &&
          events.length > 0 &&
          h(
            'small',
            [
              sanctions && `${sanctions} sanction${sanctions > 1 ? 's' : ''}`,
              absences && `${absences} abs./retard${absences > 1 ? 's' : ''}`,
              cheers && `${cheers} encouragement${cheers > 1 ? 's' : ''}`,
            ]
              .filter(Boolean)
              .join(', '),
          ),
      ),
    ),
    notes.length > 0 &&
      h(
        'ul.note-list',
        notes.slice(0, 5).map((n) => noteRow(child, n, false, true)),
      ),
    exams.length > 0 &&
      h(
        'ul.recap-exams',
        exams.map((t) => h('li', icon('flag', 16), h('b', subjectLabel(t.subject)), h('span', relativeDay(t.dueDate)))),
      ),
    h(
      'div.row-actions',
      h('button.link-button', { type: 'button', onclick: () => actions.go('child', child.id) }, `Voir ${child.name}`),
    ),
  );
}

export function recapView(actions: Actions): HTMLElement {
  const children = state.data?.children ?? [];
  const today = parisDate(new Date());
  const from = shift(today, -6);
  return h(
    'div.screen.recap',
    sky({
      title: 'Le récap de la semaine',
      subtitle: `Du ${shortDay(from)} au ${capitalize(longDay(today)).toLowerCase()}`,
      back: () => actions.go('home'),
    }),
    h(
      'div.lift.flow',
      children.length === 0
        ? emptyState('Aucun élève', 'Connecte ÉcoleDirecte pour voir la semaine des enfants.')
        : children.map((c) => childRecap(c, actions, from, today)),
    ),
    h(
      'p.footnote',
      'Chaque enfant est présenté pour lui-même : l’évolution compare ses résultats récents aux siens, jamais à ceux des autres.',
    ),
  );
}

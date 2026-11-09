/**
 * Onglet Devoirs, compléments :
 * - la semaine d'un coup d'œil (sept jours, devoirs restants et contrôles) ;
 * - « En classe » : ce que les professeurs ont noté avoir fait pendant les séances,
 *   pour rattraper un cours manqué ou réviser.
 */
import { h, icon } from './dom.ts';
import { capitalize, longDay, relativeDay, subjectLabel } from './format.ts';
import { state } from './state.ts';
import { emptyState, subjectMark, type Actions } from './views.ts';
import { parisDate, parisHour } from '../shared/metrics.ts';
import type { Child, Homework } from '../shared/types.ts';

const DAY = 86400000;
const shift = (date: string, days: number) =>
  new Date(Date.parse(date + 'T12:00:00Z') + days * DAY).toISOString().slice(0, 10);
const weekday = (date: string) => new Date(date + 'T12:00:00Z').getUTCDay();
const short = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', timeZone: 'UTC' });
const dayNum = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', timeZone: 'UTC' });

export const lessonKey = (childId: string, date: string) => `${childId}|${date}`;

/** Sept jours à partir d'aujourd'hui : combien reste-t-il à faire, et y a-t-il un contrôle ? */
export function weekStrip(items: Homework[], checks: Set<string>, actions: Actions): HTMLElement {
  const today = parisDate(new Date());
  const days = Array.from({ length: 7 }, (_, i) => shift(today, i));
  return h(
    'nav.week',
    { 'aria-label': 'La semaine' },
    days.map((date) => {
      const due = items.filter((t) => t.dueDate === date);
      const left = due.filter((t) => !checks.has(t.id)).length;
      const exam = due.some((t) => t.exam);
      const active = state.taskDay === date;
      const off = [0, 6].includes(weekday(date));
      return h(
        `button.week-day${active ? '.is-active' : ''}${off ? '.is-off' : ''}${due.length && !left ? '.is-done' : ''}`,
        {
          type: 'button',
          'aria-pressed': String(active),
          'aria-label': `${relativeDay(date)} : ${due.length ? `${left} devoir${left > 1 ? 's' : ''} à faire` : 'rien à rendre'}${exam ? ', contrôle' : ''}`,
          onclick: () => {
            state.taskDay = active ? null : date;
            actions.rerender();
          },
        },
        h('span.week-name', date === today ? 'Auj.' : capitalize(short.format(new Date(date + 'T12:00:00Z')))),
        h('span.week-num', dayNum.format(new Date(date + 'T12:00:00Z'))),
        h(
          'span.week-load',
          due.length === 0 ? '·' : left === 0 ? icon('check', 14) : String(left),
          exam && h('span.week-exam', { title: 'Contrôle' }),
        ),
      );
    }),
  );
}

/** Derniers jours de classe (du plus récent au plus ancien), aujourd'hui compris l'après-midi. */
function pastSchoolDays(count: number): string[] {
  const now = new Date();
  const today = parisDate(now);
  const hour = parisHour(now);
  const out: string[] = [];
  let d = hour >= 12 ? today : shift(today, -1);
  while (out.length < count) {
    if (![0, 6].includes(weekday(d))) out.push(d);
    d = shift(d, -1);
  }
  return out;
}

export function lessonsBody(child: Child, actions: Actions): HTMLElement {
  const days = pastSchoolDays(6);
  const date = state.lessonDay && days.includes(state.lessonDay) ? state.lessonDay : (days[0] as string);
  const entry = state.lessons.get(lessonKey(child.id, date));
  if (!entry) actions.loadLessons(child.id, date);
  const lessons = entry?.value ?? null;
  return h(
    'div.class-days',
    h(
      'div.chips.class-pick',
      { role: 'tablist', 'aria-label': 'Jour de classe' },
      days.map((d) =>
        h(
          `button.chip-button${d === date ? '.is-active' : ''}`,
          {
            type: 'button',
            role: 'tab',
            'aria-selected': String(d === date),
            onclick: () => {
              state.lessonDay = d;
              actions.rerender();
            },
          },
          relativeDay(d),
        ),
      ),
    ),
    h('p.day-date', capitalize(longDay(date))),
    entry?.error &&
      h(
        'div.inline-error',
        entry.error,
        h(
          'button.link-button',
          { type: 'button', onclick: () => actions.loadLessons(child.id, date, true) },
          'Réessayer',
        ),
      ),
    !lessons &&
      !entry?.error &&
      h(
        'ul.task-list.is-loading',
        [0, 1, 2].map(() => h('li.skeleton')),
      ),
    lessons &&
      (lessons.length === 0
        ? emptyState(
            'Rien de noté ce jour-là',
            'Les professeurs n’ont pas rempli le contenu des séances sur ÉcoleDirecte.',
          )
        : h(
            'ul.lesson-list',
            lessons.map((l) =>
              h(
                'li.lesson',
                h(
                  'p.lesson-head',
                  subjectMark(l.subject),
                  h('b', subjectLabel(l.subject)),
                  l.teacher && h('span', l.teacher),
                ),
                l.text && h('p.lesson-text', l.text),
                l.documents.length > 0 &&
                  h(
                    'p.lesson-docs',
                    l.documents.map((name) => h('span.chip', icon('file', 14), name)),
                  ),
              ),
            ),
          )),
    h(
      'p.footnote',
      'Rempli par les professeurs dans le cahier de textes. Les documents joints s’ouvrent sur ÉcoleDirecte.',
    ),
  );
}

/**
 * Écran « Mon cartable » : une seule page pour le matin (ou la veille au soir).
 * Ce qui est à rendre, les cours de la journée, ce qui change (cours annulés,
 * contrôles, infos du collège) et la liste du sac à cocher.
 */
import { h, icon, tap } from './dom.ts';
import { capitalize, longDay, relativeDay, subjectLabel } from './format.ts';
import { state } from './state.ts';
import { accent, emptyState, sectionHead, sky, subjectMark, taskRow, type Actions } from './views.ts';
import { bagCourses, bagDate, defaultItems, subjectKey } from '../shared/bag.ts';
import { nextSchoolDay, parisDate } from '../shared/metrics.ts';
import type { BagDay, BagItem, Child, Course, Kit } from '../shared/types.ts';

const weekday = (date: string) =>
  new Intl.DateTimeFormat('fr-FR', { weekday: 'long', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'));

const hourText = (hhmm: string) => {
  const [h = '0', m = '00'] = hhmm.split(':');
  return m === '00' ? `${Number(h)} h` : `${Number(h)} h ${m}`;
};

export function bagKey(childId: string, date: string | null): string {
  return `${childId}|${date ?? 'auto'}`;
}

function packRow(child: Child, day: BagDay, item: BagItem, packed: Set<string>, actions: Actions): HTMLElement {
  const done = packed.has(item.id);
  return h(
    `li.pack${done ? '.is-done' : ''}`,
    h(
      'button.pack-button',
      {
        type: 'button',
        role: 'checkbox',
        'aria-checked': String(done),
        onclick: () => {
          tap(done ? 8 : 16);
          actions.togglePacked(child.id, day.date, item.id, !done);
        },
      },
      h('span.pack-box', icon('check', 18)),
      h('span.pack-label', item.label),
      item.subject && h('span.pack-subject', subjectLabel(item.subject)),
    ),
  );
}

function courseRow(c: Course, exams: Set<string>): HTMLElement {
  const exam = exams.has(c.subject.toUpperCase());
  return h(
    `li.course${c.cancelled ? '.is-cancelled' : ''}`,
    h('span.course-time', hourText(c.start), h('small', hourText(c.end))),
    h(
      'span.course-main',
      h(
        'span.course-subject',
        subjectMark(c.subject),
        subjectLabel(c.subject),
        c.cancelled && h('span.badge-exam', 'Annulé'),
        !c.cancelled && c.modified && h('span.badge-new', 'Modifié'),
        !c.cancelled && exam && h('span.badge-exam', 'Contrôle'),
        c.exempted && h('span.badge-new', 'Dispensé'),
        c.kind === 'permanence' && h('span.badge-new', 'Permanence'),
      ),
      h('span.course-meta', [c.room, c.teacher].filter(Boolean).join(', ')),
    ),
  );
}

export function bagView(child: Child, actions: Actions): HTMLElement {
  const auto = bagDate();
  const today = parisDate(new Date());
  const tomorrow = nextSchoolDay(new Date());
  const choices: { date: string | null; label: string }[] =
    auto.focus === 'today'
      ? [
          { date: null, label: 'Aujourd’hui' },
          { date: tomorrow, label: relativeDay(tomorrow) },
        ]
      : [
          { date: null, label: relativeDay(auto.date) },
          { date: nextSchoolDay(new Date(auto.date + 'T12:00:00Z')), label: 'Après' },
        ];
  const key = bagKey(child.id, state.bagDay);
  const bag = state.bags.get(key);
  if (!bag) actions.loadBag(child.id, state.bagDay);
  const day = bag?.day ?? null;
  const picker = h(
    'div.segmented',
    { role: 'tablist', 'aria-label': 'Jour' },
    choices.map((c) =>
      h(
        `button${state.bagDay === c.date ? '.is-active' : ''}`,
        {
          type: 'button',
          role: 'tab',
          'aria-selected': String(state.bagDay === c.date),
          onclick: () => {
            state.bagDay = c.date;
            actions.rerender();
          },
        },
        c.label,
      ),
    ),
  );
  const parent = state.session?.me?.role === 'parent';
  const top = sky({
    title: parent ? `Cartable de ${child.name}` : 'Mon cartable',
    subtitle: day ? capitalize(longDay(day.date)) : null,
    back: parent ? () => actions.go('child', child.id) : null,
    extra: [picker],
  });
  if (!day)
    return h(
      'div.screen.bag',
      { style: accent(child.id) },
      top,
      bag?.error
        ? h(
            'div.inline-error',
            bag.error,
            h(
              'button.link-button',
              { type: 'button', onclick: () => actions.loadBag(child.id, state.bagDay) },
              'Réessayer',
            ),
          )
        : h(
            'div.bag-loading',
            [0, 1, 2, 3].map(() => h('div.skeleton')),
          ),
    );

  const packed = new Set(day.packed);
  const checks = new Set(state.data?.checks[child.id] ?? []);
  const attending = bagCourses(day.courses);
  const lessons = day.courses.filter((c) => c.kind !== 'conge');
  const exams = new Set(day.homework.filter((h) => h.exam).map((h) => h.subject.toUpperCase()));
  const first = attending[0];
  const last = attending.at(-1);
  const forCourses = day.items.filter((i) => i.subject);
  const always = day.items.filter((i) => !i.subject);
  const total = day.items.length;
  const ready = day.items.filter((i) => packed.has(i.id)).length;
  const allPacked = total > 0 && ready === total;
  const pendingHomework = day.homework.filter((t) => !checks.has(t.id));
  const cancelled = day.courses.filter((c) => c.cancelled);
  const noSchool = !day.timetableError && attending.length === 0;
  const alerts: HTMLElement[] = [
    ...cancelled.map((c) => h('li.alert-item', `${subjectLabel(c.subject)} annulé à ${hourText(c.start)}`)),
    ...day.homework
      .filter((t) => t.exam)
      .map((t) => h('li.alert-item.is-exam', `Contrôle de ${subjectLabel(t.subject).toLowerCase()} : relis ta leçon`)),
    ...day.infos.map((i) => h('li.alert-item.is-info', i.text)),
  ];

  return h(
    'div.screen.bag',
    { style: accent(child.id) },
    top,
    h(
      `section.bag-hero.lift${allPacked ? '.is-ready' : ''}`,
      h(
        'div.bag-hero-text',
        h('p.bag-day', day.date === today ? 'Aujourd’hui' : capitalize(weekday(day.date))),
        noSchool
          ? h('p.bag-hours', 'Pas de cours prévu')
          : first && last && h('p.bag-hours', `${hourText(first.start)} – ${hourText(last.end)}`),
        !noSchool &&
          h(
            'p.bag-count',
            `${attending.length} cours, ${day.homework.length} devoir${day.homework.length > 1 ? 's' : ''} à rendre`,
          ),
      ),
      total > 0 &&
        h(
          'div.bag-meter',
          { role: 'img', 'aria-label': `${ready} affaires sur ${total} dans le sac` },
          h('span.bag-meter-value', allPacked ? 'Prêt' : `${ready}/${total}`),
          h('span.bag-meter-bar', h('span', { style: { width: `${(ready / total) * 100}%` } })),
          h('span.bag-meter-label', allPacked ? 'Cartable bouclé' : 'dans le sac'),
        ),
    ),
    alerts.length > 0 && h('ul.alert-items', alerts),
    day.timetableError && h('p.inline-note', `Emploi du temps : ${day.timetableError}`),
    h(
      'section.block',
      sectionHead(
        'À rendre',
        day.homework.length > 0 &&
          h(
            'span.counter',
            pendingHomework.length
              ? `${pendingHomework.length} pas encore coché${pendingHomework.length > 1 ? 's' : ''}`
              : 'Tout est fait',
          ),
      ),
      day.homeworkError
        ? h('p.inline-note', day.homeworkError)
        : day.homework.length
          ? h(
              'ul.task-list',
              day.homework.map((t) => taskRow(child, t, actions, checks)),
            )
          : emptyState('Rien à rendre', 'Aucun devoir prévu pour ce jour sur ÉcoleDirecte.'),
    ),
    total > 0 &&
      h(
        'section.block',
        sectionHead(
          'Dans mon sac',
          h('button.link-button', { type: 'button', onclick: () => actions.editKit(child) }, 'Modifier'),
        ),
        forCourses.length > 0 &&
          h(
            'ul.pack-list',
            forCourses.map((i) => packRow(child, day, i, packed, actions)),
          ),
        always.length > 0 && h('p.pack-group', 'Tous les jours'),
        always.length > 0 &&
          h(
            'ul.pack-list',
            always.map((i) => packRow(child, day, i, packed, actions)),
          ),
      ),
    lessons.length > 0 &&
      h(
        'section.block',
        sectionHead('Mes cours'),
        h(
          'ul.course-list',
          lessons.map((c) => courseRow(c, exams)),
        ),
      ),
    noSchool &&
      emptyState(
        'Pas de cours',
        'ÉcoleDirecte n’indique aucun cours ce jour-là (vacances, jour férié ou emploi du temps pas encore publié).',
      ),
  );
}

/** Carte d'accès rapide affichée en haut de l'accueil élève. */
export function bagCard(child: Child, actions: Actions): HTMLElement {
  const bag = state.bags.get(bagKey(child.id, null));
  if (!bag) actions.loadBag(child.id, null);
  const day = bag?.day;
  const auto = bagDate();
  const ready = day ? day.items.filter((i) => day.packed.includes(i.id)).length : 0;
  const total = day?.items.length ?? 0;
  const done = total > 0 && ready === total;
  return h(
    `button.bag-card${done ? '.is-ready' : ''}`,
    { type: 'button', onclick: () => actions.go('bag', child.id) },
    h('span.bag-card-icon', icon(done ? 'check' : 'bag', 22)),
    h(
      'span.bag-card-text',
      h(
        'b',
        auto.focus === 'today' ? 'Mon cartable du jour' : `Mon cartable pour ${relativeDay(auto.date).toLowerCase()}`,
      ),
      h(
        'small',
        !day
          ? 'Préparation…'
          : done
            ? 'Tout est dans le sac'
            : `${bagCourses(day.courses).length} cours, ${day.homework.length} à rendre, ${ready}/${total} dans le sac`,
      ),
    ),
    icon('next', 18),
  );
}

/** Feuille d'édition du matériel : par matière du jour, et pour tous les jours. */
export function kitSheet(
  child: Child,
  day: BagDay,
  openSheet: (title: string, build: (close: () => void) => HTMLElement) => void,
  save: (kit: Kit) => Promise<void>,
): void {
  const kit: Kit = { always: [...day.kit.always], subjects: { ...day.kit.subjects } };
  const subjects: string[] = [];
  for (const c of bagCourses(day.courses))
    if (!subjects.some((s) => subjectKey(s) === subjectKey(c.subject))) subjects.push(c.subject);
  openSheet(`Matériel de ${child.name}`, (close) => {
    const body = h('div.sheet-body');
    const group = (title: string, get: () => string[], set: (list: string[]) => void) => {
      const list = h('ul.kit-list');
      const paint = () => {
        list.replaceChildren(
          ...get().map((label, i) =>
            h(
              'li.kit-chip',
              h('span', label),
              h(
                'button.kit-remove',
                {
                  type: 'button',
                  'aria-label': `Retirer ${label}`,
                  onclick: () => {
                    set(get().filter((_, j) => j !== i));
                    paint();
                  },
                },
                icon('close', 14),
              ),
            ),
          ),
        );
      };
      const input = h('input.text-input.kit-input', {
        placeholder: 'Ajouter un objet',
        'aria-label': `Ajouter un objet : ${title}`,
        maxlength: 60,
      });
      const add = () => {
        const v = input.value.trim();
        if (!v) return;
        set([...get(), v]);
        input.value = '';
        paint();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          add();
        }
      });
      paint();
      return h(
        'section.sheet-section',
        h('h3', title),
        list,
        h(
          'div.kit-add',
          input,
          h('button.button.button-small', { type: 'button', onclick: add }, icon('plus', 16), 'Ajouter'),
        ),
      );
    };
    for (const subject of subjects) {
      const k = subjectKey(subject);
      body.append(
        group(
          subjectLabel(subject),
          () => kit.subjects[k] ?? defaultItems(subject),
          (list) => {
            kit.subjects[k] = list;
          },
        ),
      );
    }
    body.append(
      group(
        'Tous les jours',
        () => kit.always,
        (list) => {
          kit.always = list;
        },
      ),
      h('p.hint', 'Le matériel est enregistré par matière : il resservira chaque jour où la matière est au programme.'),
      h(
        'div.sheet-actions',
        h('button.button', { type: 'button', onclick: close }, 'Annuler'),
        h(
          'button.button.button-primary',
          {
            type: 'button',
            onclick: async () => {
              await save(kit);
              close();
            },
          },
          'Enregistrer',
        ),
      ),
    );
    return body;
  });
}

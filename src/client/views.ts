/**
 * Écrans principaux : accueil (famille ou élève), devoirs, notes et progrès.
 * Chaque fonction renvoie un élément complet ; `app.ts` remplace la vue courante.
 */
import { h, icon, tap } from './dom.ts';
import {
  average,
  clockText,
  capitalize,
  dueFocus,
  grade,
  greeting,
  initial,
  longDay,
  relativeDay,
  signed,
  sinceText,
  subjectHue,
  subjectLabel,
} from './format.ts';
import { orbit } from './orbit.ts';
import { progressChart } from './chart.ts';
import { bagKey } from './bag-view.ts';
import { familyLifeBlock, lifeCard, lifeFacts } from './life-view.ts';
import { lessonsBody, weekStrip } from './class-view.ts';
import { familyDocsBlock } from './docs-view.ts';
import { familyMailBlock, mailCard } from './mail-view.ts';
import { trainCard } from './train-view.ts';
import { state } from './state.ts';
import { gradeBand, metrics, noteKey, parisDate, subjectGroups, toTwenty, valid } from '../shared/metrics.ts';
import type { Child, ColorKey, Homework, Note, Period, SubjectAverage } from '../shared/types.ts';

export interface Actions {
  go(route: string, childId?: string): void;
  select(childId: string): void;
  toggleCheck(childId: string, homeworkId: string, done: boolean): void;
  loadHomework(childId: string, more?: boolean): void;
  loadCoaching(childId: string): void;
  loadBag(childId: string, date: string | null): void;
  togglePacked(childId: string, date: string, itemId: string, packed: boolean): void;
  editKit(child: Child): void;
  refresh(): void;
  rerender(): void;
  /** Boîte de réception : `family` ou identifiant d'élève. */
  loadMail(scope: string, refresh?: boolean): void;
  openMessage(key: string): void;
  loadMessage(key: string): void;
  share(key: string, childIds: string[]): void;
  loadLife(childId: string, refresh?: boolean): void;
  loadLessons(childId: string, date: string, refresh?: boolean): void;
}

/* ---------- En-tête « ciel » ---------- */

export interface SkyOptions {
  title: string;
  subtitle?: string | null;
  back?: (() => void) | null;
  actions?: (HTMLElement | null | false | undefined)[];
  /** Contenu sous le titre, dans le ciel : orbite, sélecteur d'élève… */
  extra?: (HTMLElement | null | false | undefined)[];
  big?: boolean;
}

/**
 * En-tête de chaque écran : un ciel à la couleur du membre (ou de l'élève
 * affiché), qui passe sous la barre d'état du téléphone.
 */
export function sky(o: SkyOptions): HTMLElement {
  return h(
    `header.top${o.big ? '.is-big' : ''}`,
    h(
      'div.sky-bar',
      o.back &&
        h(
          'button.icon-button.sky-button',
          {
            type: 'button',
            'aria-label': 'Retour',
            onclick: () => {
              tap();
              o.back?.();
            },
          },
          icon('back'),
        ),
      h('div.top-text', h('h1.title', o.title), o.subtitle ? h('p.subtitle', o.subtitle) : null),
      ...(o.actions ?? []),
    ),
    ...(o.extra ?? []),
  );
}

export function skyButton(label: string, name: string, onclick: () => void, disabled = false): HTMLElement {
  return h(
    'button.icon-button.sky-button',
    { type: 'button', 'aria-label': label, title: label, disabled, onclick },
    icon(name),
  );
}

/* ---------- Repères communs ---------- */

export function childColor(childId: string): ColorKey {
  const member = state.members.find((m) => m.studentId === childId);
  if (member) return member.color;
  const me = state.session?.me;
  if (me?.role === 'child' && me.studentId === childId) return me.color;
  const order: ColorKey[] = ['soleil', 'lagon', 'corail', 'menthe', 'prune', 'comete'];
  const index = state.data?.children.findIndex((c) => c.id === childId) ?? 0;
  return order[Math.max(0, index) % order.length] ?? 'comete';
}

export const accent = (childId: string) => ({ '--accent': `var(--c-${childColor(childId)})` });

function gradePill(n: Note): HTMLElement {
  const v = toTwenty(n.value, n.outOf);
  const band = gradeBand(n);
  const text = n.value === null ? n.raw || '–' : grade(n.value);
  return h(
    `span.grade.band-${band}`,
    { 'aria-label': n.value === null ? `Note ${text}` : `${grade(n.value)} sur ${grade(n.outOf)}` },
    h('b', text),
    n.value !== null && n.outOf !== 20 && h('small', `/${grade(n.outOf)}`),
    n.value !== null && n.outOf !== 20 && v !== null && h('span.sr-only', ` soit ${grade(v)} sur 20`),
  );
}

export function subjectMark(subject: string): HTMLElement {
  return h('span.subject-mark', { style: { '--h': String(subjectHue(subject.split(' · ')[0] ?? subject)) } });
}

export function noteRow(child: Child, n: Note, showChild = false, showSubject = true): HTMLElement {
  const fresh = state.fresh.has(noteKey(child.id, n));
  const skills = (n.skills ?? []).filter((s) => s.level !== null);
  return h(
    `li.note-row${fresh ? '.is-fresh' : ''}`,
    gradePill(n),
    h(
      'div.note-main',
      showSubject
        ? h('p.note-subject', subjectMark(n.subject), subjectLabel(n.subject), fresh && h('span.badge-new', 'Nouveau'))
        : h('p.note-subject', n.title, fresh && h('span.badge-new', 'Nouveau')),
      showSubject && h('p.note-title', n.title),
      h(
        'p.note-meta',
        showChild && h('span.child-tag', { style: accent(child.id) }, child.name),
        n.date && h('span', relativeDay(n.date)),
        n.classAverage !== null && h('span', `classe ${grade(toTwenty(n.classAverage, n.outOf))}`),
        n.coefficient !== null && n.coefficient !== 1 && h('span', `coef ${grade(n.coefficient)}`),
        n.excluded && h('span', 'hors moyenne'),
      ),
      n.comment && h('p.note-comment', n.comment),
      skills.length > 0 &&
        h(
          'p.skills',
          { 'aria-label': 'Compétences évaluées' },
          skills.slice(0, 8).map((s) => h(`span.skill.level-${s.level}`, { title: s.name })),
        ),
    ),
  );
}

export function emptyState(title: string, text: string, action?: HTMLElement): HTMLElement {
  return h('div.empty', h('p.empty-title', title), h('p.empty-text', text), action);
}

export function sectionHead(title: string, extra?: HTMLElement | string | false): HTMLElement {
  return h('header.section-head', h('h2', title), extra || null);
}

/** Sélecteur d'élève (parents) en haut des onglets. */
export function childSwitcher(actions: Actions): HTMLElement | null {
  const children = state.data?.children ?? [];
  if (state.session?.me?.role !== 'parent' || children.length < 2) return null;
  return h(
    'nav.switcher',
    { 'aria-label': 'Choisir un enfant' },
    children.map((c) =>
      h(
        `button.switch${c.id === state.selected ? '.is-active' : ''}`,
        {
          type: 'button',
          style: accent(c.id),
          'aria-pressed': String(c.id === state.selected),
          onclick: () => {
            tap();
            actions.select(c.id);
          },
        },
        h('span.avatar.avatar-xs', initial(c.name)),
        c.name,
      ),
    ),
  );
}

/* ---------- Devoirs ---------- */

export function taskRow(child: Child, t: Homework, actions: Actions, checks: Set<string>): HTMLElement {
  const done = checks.has(t.id);
  const open = state.openTask === t.id;
  return h(
    `li.task${done ? '.is-done' : ''}${open ? '.is-open' : ''}`,
    h(
      'button.check',
      {
        type: 'button',
        role: 'checkbox',
        'aria-checked': String(done),
        'aria-label': `${done ? 'Marquer à faire' : 'Marquer fait'} : ${subjectLabel(t.subject)}`,
        onclick: () => {
          tap(done ? 8 : 18);
          actions.toggleCheck(child.id, t.id, !done);
        },
      },
      icon('check', 18),
    ),
    h(
      'button.task-body',
      {
        type: 'button',
        'aria-expanded': String(open),
        onclick: () => {
          state.openTask = open ? null : t.id;
          actions.rerender();
        },
      },
      h(
        'span.task-subject',
        subjectMark(t.subject),
        subjectLabel(t.subject),
        t.exam && h('span.badge-exam', 'Contrôle'),
      ),
      h('span.task-text', t.text || 'Consigne non détaillée sur ÉcoleDirecte.'),
      t.documents.length > 0 &&
        h(
          'span.task-docs',
          icon('clip', 14),
          t.documents.length === 1 ? t.documents[0] : `${t.documents.length} pièces jointes`,
        ),
    ),
  );
}

function homeworkBlock(child: Child, actions: Actions, mode: 'focus' | 'all'): HTMLElement {
  const hw = state.homework.get(child.id);
  if (!hw?.loaded) {
    if (!hw?.loading && !hw?.error) actions.loadHomework(child.id);
    if (hw?.error)
      return h(
        'div.inline-error',
        hw.error,
        h('button.link-button', { type: 'button', onclick: () => actions.loadHomework(child.id) }, 'Réessayer'),
      );
    return h(
      'ul.task-list.is-loading',
      [0, 1, 2].map(() => h('li.skeleton')),
    );
  }
  const checks = new Set(state.data?.checks[child.id] ?? []);
  const focus = dueFocus();
  const today = parisDate(new Date());
  if (mode === 'focus') {
    const soon = hw.items.filter((t) => t.dueDate <= focus);
    const left = soon.filter((t) => !checks.has(t.id)).length;
    const later = hw.items.find((t) => t.dueDate > focus);
    return h(
      'section.block',
      sectionHead(
        focus === today ? 'Pour aujourd’hui' : `Pour ${relativeDay(focus).toLowerCase()}`,
        soon.length > 0 && h('span.counter', left === 0 ? 'Tout est fait' : `${left} à faire`),
      ),
      soon.length > 0 &&
        left === 0 &&
        h('p.all-done', { role: 'status' }, icon('star', 20), h('span', 'Tout est fait. Bien joué !')),
      soon.length
        ? h(
            'ul.task-list',
            soon.map((t) => taskRow(child, t, actions, checks)),
          )
        : emptyState(
            'Rien à rendre',
            later
              ? `Prochain devoir : ${subjectLabel(later.subject)}, ${relativeDay(later.dueDate).toLowerCase()}.`
              : 'Aucun devoir prévu pour le moment.',
          ),
      hw.items.length > soon.length &&
        h(
          'button.more-link',
          { type: 'button', onclick: () => actions.go('tasks', child.id) },
          `Voir les ${hw.items.length - soon.length} suivants`,
        ),
    );
  }
  // Mode « tous » : la semaine d'un coup d'œil, puis regroupés par jour avec progression.
  const days = new Map<string, Homework[]>();
  for (const t of hw.items)
    if (!state.taskDay || t.dueDate === state.taskDay) days.set(t.dueDate, [...(days.get(t.dueDate) ?? []), t]);
  return h(
    'div.days',
    weekStrip(hw.items, checks, actions),
    hw.partial && h('p.inline-note', 'Une partie du cahier de textes n’a pas pu être lue.'),
    days.size === 0 &&
      (state.taskDay
        ? emptyState(`Rien pour ${relativeDay(state.taskDay).toLowerCase()}`, 'Aucun devoir à rendre ce jour-là.')
        : emptyState('Aucun devoir à venir', 'Le cahier de textes est vide pour les prochaines semaines.')),
    [...days].map(([date, items]) => {
      const done = items.filter((t) => checks.has(t.id)).length;
      const summary = hw.dates.find((d) => d.date === date);
      const total = items.length;
      return h(
        'section.day',
        h(
          'header.day-head',
          h('h2', relativeDay(date)),
          h('span.day-date', capitalize(longDay(date))),
          h(
            'span.day-progress',
            {
              role: 'progressbar',
              'aria-valuemin': 0,
              'aria-valuemax': total,
              'aria-valuenow': done,
              'aria-label': `${done} sur ${total} faits`,
            },
            h('span', { style: { width: `${total ? (done / total) * 100 : 0}%` } }),
          ),
        ),
        h(
          'ul.task-list',
          items.map((t) => taskRow(child, t, actions, checks)),
        ),
        summary?.done
          ? h('p.day-foot', `${summary.done} déjà coché${summary.done > 1 ? 's' : ''} sur ÉcoleDirecte`)
          : null,
      );
    }),
    hw.next !== null &&
      !state.taskDay &&
      h(
        'button.button.button-wide',
        { type: 'button', disabled: hw.moreLoading, onclick: () => actions.loadHomework(child.id, true) },
        hw.moreLoading ? 'Chargement…' : 'Afficher la suite',
      ),
  );
}

/* ---------- Accueil ---------- */

function coachingLine(child: Child, actions: Actions): HTMLElement | null {
  if (!state.session?.coaching || !child.notes.some(valid)) return null;
  const c = state.coaching.get(child.id);
  if (!c) {
    actions.loadCoaching(child.id);
    return h('p.coach.is-loading', h('span.skeleton-line'));
  }
  if (c.loading) return h('p.coach.is-loading', h('span.skeleton-line'));
  if (c.failed || !c.text) return null;
  return h('p.coach', icon('bolt', 16), h('span', c.text));
}

function recentNotes(child: Child, limit: number): Note[] {
  return [...child.notes]
    .filter((n) => n.date)
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
    .slice(0, limit);
}

/**
 * Raccourcis du jour, dans le ciel à côté de l'orbite : ce qu'il reste à faire,
 * le cartable, les messages. Un coup de pouce suffit pour y aller.
 */
function pulse(child: Child, actions: Actions, asParent: boolean): HTMLElement {
  const focus = dueFocus();
  const hw = state.homework.get(child.id);
  const checks = new Set(state.data?.checks[child.id] ?? []);
  const left = hw?.loaded ? hw.items.filter((t) => t.dueDate <= focus && !checks.has(t.id)).length : null;
  const bag = state.bags.get(bagKey(child.id, null));
  if (!bag) actions.loadBag(child.id, null);
  const day = bag?.day;
  const total = day?.items.length ?? 0;
  const packed = day ? day.items.filter((i) => day.packed.includes(i.id)).length : 0;
  const unread = state.mail.get(child.id)?.value?.unread ?? 0;
  const tile = (route: string, ico: string, value: string | null, label: string, done: boolean, alert = false) =>
    h(
      `button.pulse${done ? '.is-done' : ''}${alert ? '.is-alert' : ''}`,
      {
        type: 'button',
        onclick: () => {
          tap();
          actions.go(route, child.id);
        },
      },
      h('span.pulse-icon', icon(done ? 'check' : ico, 20)),
      h('span.pulse-text', h('b', value ?? '…'), h('small', label)),
    );
  return h(
    'div.pulses',
    tile(
      'tasks',
      'tasks',
      left === null ? null : left === 0 ? 'Fait' : String(left),
      left === 0 ? 'devoirs' : `devoir${(left ?? 2) > 1 ? 's' : ''} à faire`,
      left === 0,
    ),
    tile(
      'bag',
      'bag',
      !day ? null : total === 0 ? '–' : packed === total ? 'Prêt' : `${packed}/${total}`,
      'cartable',
      total > 0 && packed === total,
    ),
    !asParent &&
      tile('messages', 'mail', String(unread), unread > 1 ? 'nouveaux messages' : 'nouveau message', false, unread > 0),
  );
}

export function studentHome(child: Child, actions: Actions, asParent: boolean): HTMLElement {
  const me = state.session?.me;
  const freshCount = child.notes.filter((n) => state.fresh.has(noteKey(child.id, n))).length;
  return h(
    'div.screen.student',
    { style: accent(child.id) },
    sky({
      title: asParent ? child.name : greeting(me?.name ?? child.name),
      subtitle: [child.className, child.school].filter(Boolean).join(' · '),
      back: asParent ? () => actions.go('home') : null,
      actions: [
        !asParent &&
          me &&
          h(
            'button.avatar.avatar-btn.sky-avatar',
            { type: 'button', 'aria-label': 'Mon profil et réglages', onclick: () => actions.go('me') },
            initial(me.name),
          ),
      ],
      extra: [h('div.hero-row', h('div.hero', orbit(child, { fresh: state.fresh })), pulse(child, actions, asParent))],
      big: true,
    }),
    child.error && h('p.inline-error', child.error),
    h(
      'div.flow',
      coachingLine(child, actions),
      homeworkBlock(child, actions, 'focus'),
      trainCard(child, actions, asParent),
      !asParent && mailCard(child, actions),
      lifeCard(child, actions),
      h(
        'section.block',
        sectionHead(
          'Dernières notes',
          freshCount > 0 && h('span.counter.counter-accent', `${freshCount} nouvelle${freshCount > 1 ? 's' : ''}`),
        ),
        child.notes.length
          ? h(
              'ul.note-list',
              recentNotes(child, 5).map((n) => noteRow(child, n)),
            )
          : emptyState('Pas encore de note', 'Les notes apparaîtront ici dès leur publication.'),
        child.notes.length > 5 &&
          h('button.more-link', { type: 'button', onclick: () => actions.go('grades', child.id) }, 'Toutes les notes'),
      ),
    ),
  );
}

export function familyHome(actions: Actions): HTMLElement {
  const me = state.session?.me;
  const children = state.data?.children ?? [];
  const feed = children
    .flatMap((c) => c.notes.filter((n) => n.date).map((n) => ({ c, n })))
    .sort((a, b) => (b.n.date ?? '').localeCompare(a.n.date ?? ''))
    .slice(0, 8);
  const focus = dueFocus();
  return h(
    'div.screen.family',
    sky({
      title: greeting(me?.name ?? ''),
      subtitle: state.data?.updatedAt ? `Mis à jour ${sinceText(state.data.updatedAt)}` : 'Famille',
      actions: [
        skyButton('Actualiser depuis ÉcoleDirecte', 'refresh', () => actions.refresh(), state.dataLoading),
        skyButton('Réglages', 'gear', () => actions.go('me')),
      ],
    }),
    children.length === 0
      ? h(
          'div.lift',
          emptyState(
            'Aucun élève pour l’instant',
            state.session?.ed?.link === 'connected'
              ? 'ÉcoleDirecte ne renvoie aucun élève du collège ou du lycée.'
              : 'Connecte le compte parent ÉcoleDirecte pour voir les enfants.',
            me?.admin
              ? h(
                  'button.button.button-primary',
                  { type: 'button', onclick: () => actions.go('me') },
                  'Connecter ÉcoleDirecte',
                )
              : undefined,
          ),
        )
      : h(
          'ul.kid-rail.lift',
          children.map((c) => {
            const m = metrics(c.notes);
            const hw = state.homework.get(c.id);
            if (!hw) actions.loadHomework(c.id);
            const checks = new Set(state.data?.checks[c.id] ?? []);
            const due = hw?.loaded ? hw.items.filter((t) => t.dueDate <= focus && !checks.has(t.id)).length : null;
            const fresh = c.notes.filter((n) => state.fresh.has(noteKey(c.id, n))).length;
            return h(
              'li',
              h(
                'button.kid',
                {
                  type: 'button',
                  style: accent(c.id),
                  onclick: () => {
                    tap();
                    actions.go('child', c.id);
                  },
                },
                h(
                  'span.kid-head',
                  h('span.avatar.avatar-sm', initial(c.name)),
                  h('span.kid-name', c.name),
                  h('span.kid-class', c.className),
                ),
                orbit(c, { size: 'mini', fresh: state.fresh }),
                h(
                  'span.kid-facts',
                  m.trend !== null &&
                    h(
                      `span.fact.trend-${Math.abs(m.trend) < 0.05 ? 'flat' : m.trend > 0 ? 'up' : 'down'}`,
                      signed(m.trend),
                    ),
                  due !== null && h('span.fact', due === 0 ? 'Devoirs faits' : `${due} devoir${due > 1 ? 's' : ''}`),
                  fresh > 0 && h('span.fact.fact-accent', `${fresh} nouvelle${fresh > 1 ? 's' : ''}`),
                  ...lifeFacts(c, actions),
                ),
                c.error && h('span.kid-error', 'Données partielles'),
              ),
            );
          }),
        ),
    edBanner(actions),
    h(
      'div.flow',
      h(
        'button.recap-link',
        { type: 'button', onclick: () => actions.go('recap') },
        icon('chart', 20),
        h(
          'span',
          h('b', 'Le récap de la semaine'),
          h('small', 'Notes, devoirs, contrôles et vie scolaire, enfant par enfant'),
        ),
        icon('next', 18),
      ),
      familyMailBlock(actions),
      familyDocsBlock(actions),
      familyLifeBlock(children, actions),
      alertsBlock(children, actions),
      feed.length > 0 &&
        h(
          'section.block',
          sectionHead(
            'Notes récentes',
            h('button.link-button', { type: 'button', onclick: () => actions.go('grades') }, 'Tout voir'),
          ),
          h(
            'ul.note-list',
            feed.map(({ c, n }) => noteRow(c, n, true)),
          ),
        ),
    ),
  );
}

function alertsBlock(children: Child[], actions: Actions): HTMLElement | null {
  const rows = children.flatMap((c) =>
    subjectGroups(c.notes)
      .map((g) => ({ c, g, m: metrics(g.notes) }))
      .filter((x) => x.m.trend !== null && x.m.trend <= -1),
  );
  if (!rows.length) return null;
  return h(
    'section.block',
    sectionHead('À accompagner'),
    h(
      'ul.alert-list',
      rows
        .slice(0, 6)
        .map(({ c, g, m }) =>
          h(
            'li',
            h(
              'button.alert-row',
              { type: 'button', style: accent(c.id), onclick: () => actions.go('progress', c.id) },
              h('span.child-tag', c.name),
              h('span.alert-subject', subjectLabel(g.label)),
              h('span.fact.trend-down', signed(m.trend)),
            ),
          ),
        ),
    ),
  );
}

function edBanner(actions: Actions): HTMLElement | null {
  const ed = state.session?.ed;
  const me = state.session?.me;
  if (state.data?.stale)
    return h(
      'p.banner',
      'ÉcoleDirecte ne répond pas : les données affichées sont celles de la dernière synchronisation.',
    );
  if (!ed || ed.link === 'connected') return null;
  if (ed.link === 'attention' || ed.link === 'disconnected')
    return h(
      'div.banner.banner-action',
      h('p', ed.message ?? 'ÉcoleDirecte n’est pas connecté.'),
      me?.admin && h('button.button.button-small', { type: 'button', onclick: () => actions.go('me') }, 'Reconnecter'),
    );
  return null;
}

/* ---------- Onglets ---------- */

export function tasksView(child: Child, actions: Actions): HTMLElement {
  const inClass = state.tasksMode === 'class';
  return h(
    'div.screen',
    { style: accent(child.id) },
    sky({
      title: inClass ? 'En classe' : 'Devoirs',
      subtitle:
        state.session?.me?.role === 'parent'
          ? child.name
          : inClass
            ? 'Ce qui a été fait en cours'
            : 'Coche ce qui est fait',
      extra: [childSwitcher(actions)],
    }),
    h(
      'div.toolbar',
      h(
        'div.segmented',
        { role: 'tablist' },
        (['todo', 'class'] as const).map((mode) =>
          h(
            `button${state.tasksMode === mode ? '.is-active' : ''}`,
            {
              type: 'button',
              role: 'tab',
              'aria-selected': String(state.tasksMode === mode),
              onclick: () => {
                state.tasksMode = mode;
                actions.rerender();
              },
            },
            mode === 'todo' ? 'À faire' : 'En classe',
          ),
        ),
      ),
    ),
    inClass ? lessonsBody(child, actions) : homeworkBlock(child, actions, 'all'),
    !inClass && h('p.footnote', 'Les cases cochées ici restent dans Orbite et ne sont pas envoyées à ÉcoleDirecte.'),
  );
}

export function gradesView(child: Child, actions: Actions): HTMLElement {
  const periods = child.periods.filter((p) => p.id && !p.annual);
  const notes = child.notes.filter((n) => state.period === 'all' || n.period === state.period);
  const period = child.periods.find((p) => p.id === state.period);
  const groups = subjectGroups(notes);
  // Moyennes officielles par matière : celles de la période choisie, ou de l'année.
  const official = new Map(
    ((state.period === 'all' ? child.periods.find((p) => p.annual) : period)?.subjects ?? []).map((s) => [s.id, s]),
  );
  return h(
    'div.screen',
    { style: accent(child.id) },
    sky({
      title: state.notesMode === 'progress' ? 'Progrès' : 'Notes',
      subtitle: state.session?.me?.role === 'parent' ? child.name : child.className,
      extra: [childSwitcher(actions)],
    }),
    h(
      'div.toolbar',
      h(
        'div.segmented',
        { role: 'tablist' },
        (['recent', 'subjects', 'progress'] as const).map((mode) =>
          h(
            `button${state.notesMode === mode ? '.is-active' : ''}`,
            {
              type: 'button',
              role: 'tab',
              'aria-selected': String(state.notesMode === mode),
              onclick: () => {
                state.notesMode = mode;
                actions.rerender();
              },
            },
            mode === 'recent' ? 'Récentes' : mode === 'subjects' ? 'Matières' : 'Progrès',
          ),
        ),
      ),
      state.notesMode !== 'progress' &&
        periods.length > 0 &&
        h(
          'label.select',
          h('span.sr-only', 'Période'),
          h(
            'select',
            {
              onchange: (e: Event) => {
                state.period = (e.target as HTMLSelectElement).value;
                actions.rerender();
              },
            },
            h('option', { value: 'all', selected: state.period === 'all' }, 'Toute l’année'),
            periods.map((p) => h('option', { value: p.id, selected: state.period === p.id }, p.label || p.id)),
          ),
        ),
    ),
    state.notesMode === 'progress' && progressBody(child),
    state.notesMode !== 'progress' && councilNote(child),
    state.notesMode !== 'progress' &&
      period?.average != null &&
      h(
        'p.official',
        `Moyenne officielle ${period.label ?? ''} : `,
        h('b', average(period.average)),
        period.classAverage != null && ` (classe ${average(period.classAverage)})`,
      ),
    state.notesMode === 'progress'
      ? null
      : notes.length === 0
        ? emptyState('Aucune note', 'Rien sur cette période pour le moment.')
        : state.notesMode === 'recent'
          ? h(
              'ul.note-list',
              [...notes].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')).map((n) => noteRow(child, n)),
            )
          : h(
              'ul.subject-list',
              groups.map((g) => {
                const m = metrics(g.notes);
                const off = official.get(g.id);
                const shown = off?.average ?? m.average;
                const open = state.openSubject === g.id;
                return h(
                  `li.subject${open ? '.is-open' : ''}`,
                  h(
                    'button.subject-row',
                    {
                      type: 'button',
                      'aria-expanded': String(open),
                      onclick: () => {
                        state.openSubject = open ? null : g.id;
                        actions.rerender();
                      },
                    },
                    subjectMark(g.label),
                    h('span.subject-name', subjectLabel(g.label)),
                    m.trend !== null &&
                      h(
                        `span.fact.trend-${Math.abs(m.trend) < 0.05 ? 'flat' : m.trend > 0 ? 'up' : 'down'}`,
                        signed(m.trend),
                      ),
                    h(
                      `span.subject-avg.band-${shown == null ? 'neutral' : shown >= 14 ? 'good' : shown >= 10 ? 'average' : 'poor'}`,
                      { title: off?.average != null ? 'Moyenne officielle' : 'Moyenne indicative' },
                      average(shown),
                      off?.average != null && h('small.official-mark', 'officielle'),
                    ),
                  ),
                  open && off && officialDetail(off),
                  open &&
                    h(
                      'ul.note-list.note-list-nested',
                      [...g.notes]
                        .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
                        .map((n) => noteRow(child, n, false, false)),
                    ),
                );
              }),
            ),
    state.notesMode !== 'progress' &&
      h(
        'p.footnote',
        official.size
          ? 'Les moyennes marquées « officielle » viennent du collège. Les autres sont indicatives : notes ramenées sur 20 et pondérées.'
          : 'Moyenne indicative : notes ramenées sur 20 et pondérées, sans les coefficients des matières.',
      ),
  );
}

/** Détail d'une matière : moyenne de classe, fourchette et professeurs (jamais de rang). */
function officialDetail(s: SubjectAverage): HTMLElement | null {
  const parts = [
    s.classAverage != null && `classe ${average(s.classAverage)}`,
    s.min != null && s.max != null && `de ${average(s.min)} à ${average(s.max)}`,
    s.coefficient != null && s.coefficient !== 1 && s.coefficient !== 0 && `coef ${grade(s.coefficient)}`,
    s.teachers.length > 0 && s.teachers.join(', '),
  ].filter((x): x is string => !!x);
  return parts.length
    ? h(
        'p.subject-official',
        parts.map((p) => h('span', p)),
      )
    : null;
}

/** Prochain conseil de classe (ou celui des sept derniers jours). */
export function nextCouncil(child: Child, now = new Date()): Period | null {
  const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);
  return (
    child.periods
      .filter((p) => !p.annual && p.councilDate && p.councilDate >= weekAgo)
      .sort((a, b) => (a.councilDate ?? '').localeCompare(b.councilDate ?? ''))[0] ?? null
  );
}

function councilNote(child: Child): HTMLElement | null {
  const p = nextCouncil(child);
  if (!p?.councilDate) return null;
  const past = p.councilDate < new Date().toISOString().slice(0, 10);
  return h(
    'p.council',
    icon('flag', 18),
    h(
      'span',
      h('b', past ? 'Conseil de classe passé' : 'Conseil de classe'),
      ` ${relativeDay(p.councilDate) === 'Aujourd’hui' ? 'aujourd’hui' : longDay(p.councilDate)}`,
      p.councilTime && ` à ${clockText(p.councilTime)}`,
      p.label && ` · ${p.label}`,
      p.mainTeacher && h('small', `Professeur principal : ${p.mainTeacher}`),
    ),
  );
}

/** Progrès d'un élève, affiché dans l'onglet Notes (troisième vue). */
function progressBody(child: Child): HTMLElement {
  const m = metrics(child.notes);
  const groups = subjectGroups(child.notes)
    .map((g) => ({ g, m: metrics(g.notes) }))
    .filter((x) => x.m.count > 0);
  const strong = [...groups].sort((a, b) => (b.m.average ?? 0) - (a.m.average ?? 0)).slice(0, 3);
  const watch = groups
    .filter((x) => x.m.trend !== null && x.m.trend <= -1)
    .sort((a, b) => (a.m.trend ?? 0) - (b.m.trend ?? 0));
  const skills = child.notes.flatMap((n) => n.skills ?? []).filter((s) => s.level !== null);
  const levels = [1, 2, 3, 4].map((l) => skills.filter((s) => s.level === l).length);
  const labels = ['Insuffisante', 'Fragile', 'Satisfaisante', 'Très bonne'];
  return h(
    'div.progress',
    h(
      'dl.stats',
      h('div', h('dt', 'Moyenne'), h('dd', average(m.average))),
      h('div', h('dt', 'Sur 30 jours'), h('dd', m.trend === null ? '–' : signed(m.trend))),
      h('div', h('dt', 'Écart classe'), h('dd', m.gap === null ? '–' : signed(m.gap))),
    ),
    h('section.block', sectionHead('Évolution'), progressChart(child.notes)),
    watch.length > 0 &&
      h(
        'section.block',
        sectionHead('À travailler'),
        h(
          'ul.rank-list',
          watch.map(({ g, m: gm }) =>
            h(
              'li',
              subjectMark(g.label),
              h('span', subjectLabel(g.label)),
              h('span.fact.trend-down', signed(gm.trend)),
              h('b', average(gm.average)),
            ),
          ),
        ),
      ),
    strong.length > 0 &&
      h(
        'section.block',
        sectionHead('Points forts'),
        h(
          'ul.rank-list',
          strong.map(({ g, m: gm }) =>
            h('li', subjectMark(g.label), h('span', subjectLabel(g.label)), h('b', average(gm.average))),
          ),
        ),
      ),
    skills.length > 0 &&
      h(
        'section.block',
        sectionHead('Compétences', h('span.counter', `${skills.length} évaluées`)),
        h(
          'div.skill-bar',
          { role: 'img', 'aria-label': levels.map((n, i) => `${labels[i]} : ${n}`).join(', ') },
          levels.map((n, i) => n > 0 && h(`span.level-${i + 1}`, { style: { flex: String(n) } })),
        ),
        h(
          'ul.skill-legend',
          levels.map((n, i) => h('li', h(`span.skill.level-${i + 1}`), `${labels[i]} `, h('b', String(n)))),
        ),
      ),
  );
}

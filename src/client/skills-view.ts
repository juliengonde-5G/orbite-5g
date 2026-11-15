/**
 * Page Compétences : où en est l'élève par matière, puis les fiches de travail du jour.
 *
 * En haut, un anneau et une ligne par matière (un carré par compétence évaluée) ; au toucher, le détail
 * d'une matière montre, pour chaque compétence, le niveau ÉcoleDirecte et le travail fait dans Orbite.
 * En dessous, les compétences du jour : chacune ouvre une fiche écrite pour l'élève (rappel, exercice
 * guidé, exercices à faire seul avec corrigé masqué). Un parent peut choisir les aides qui adaptent
 * les fiches. Les données sont relues quand elles vieillissent ; l'ancien contenu reste affiché.
 */
import { api, ApiError } from './api.ts';
import { h, icon } from './dom.ts';
import { state } from './state.ts';
import { parisDate } from '../shared/metrics.ts';
import { accent, childSwitcher, emptyState, sectionHead, sky, type Actions } from './views.ts';
import type { SheetView, SkillRow, SkillsPage, SubjectOverview, TodoItem } from '../shared/skills.ts';
import { SUBJECT_LABEL } from '../shared/support.ts';
import type { Child } from '../shared/types.ts';

interface Entry<T> {
  value: T | null;
  loading: boolean;
  error: string | null;
  time?: number;
}

const pages = new Map<string, Entry<SkillsPage>>();
const sheets = new Map<string, Entry<SheetView>>();
const openSubjects = new Map<string, Set<string>>();
const openSheets = new Set<string>();
let aidError: string | null = null;

const STALE = 5 * 60000;
const isStale = (time: number | undefined): boolean =>
  Date.now() - (time ?? 0) > STALE || parisDate(new Date(time ?? 0)) !== parisDate(new Date());
const message = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
const day = (date: string | null) =>
  date ? new Date(`${date}T12:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : '';

/** Libellé lisible : ÉcoleDirecte écrit les matières en capitales (« MATHEMATIQUES »). */
const pretty = (subject: SubjectOverview): string =>
  subject.support
    ? SUBJECT_LABEL[subject.support]
    : subject.label.charAt(0).toUpperCase() + subject.label.slice(1).toLowerCase();

/** À appeler quand les données de l'application sont rechargées. */
export function markSkillsStale(): void {
  for (const entry of pages.values()) entry.time = 0;
}

function pageOf(child: Child, actions: Actions): SkillsPage | null {
  const entry = pages.get(child.id) ?? { value: null, loading: false, error: null };
  pages.set(child.id, entry);
  if (!entry.loading && !entry.error && (!entry.value || isStale(entry.time))) {
    entry.loading = true;
    api.skills
      .page(child.id)
      .then((value) => {
        entry.value = value;
        entry.time = Date.now();
      })
      .catch((e) => {
        entry.error = message(e, 'Compétences indisponibles.');
        entry.time = Date.now();
      })
      .finally(() => {
        entry.loading = false;
        actions.rerender();
      });
  }
  return entry.value;
}

function loadSheet(child: Child, key: string, actions: Actions, refresh = false): void {
  const id = `${child.id}|${key}`;
  const entry = sheets.get(id) ?? { value: null, loading: false, error: null };
  sheets.set(id, entry);
  if (entry.loading) return;
  entry.loading = true;
  entry.error = null;
  api.skills
    .sheet(child.id, key, refresh)
    .then((value) => {
      entry.value = value;
      entry.time = Date.now();
    })
    .catch((e) => {
      entry.error = message(e, 'Fiche indisponible pour le moment.');
    })
    .finally(() => {
      entry.loading = false;
      actions.rerender();
    });
}

/* ---------- Vue d'ensemble ---------- */

const STATUS_TEXT = { acquise: 'Acquise', progres: 'En cours', reprendre: 'À reprendre' } as const;

function ring(totals: SkillsPage['overview']['totals']): SVGElement {
  const total = totals.acquise + totals.progres + totals.reprendre;
  const R = 40;
  const C = 2 * Math.PI * R;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 104 104');
  svg.setAttribute('width', '104');
  svg.setAttribute('height', '104');
  svg.setAttribute('role', 'img');
  svg.setAttribute(
    'aria-label',
    `${totals.acquise} acquises, ${totals.progres} en cours, ${totals.reprendre} à reprendre sur ${total}`,
  );
  let offset = 0;
  for (const [key, color] of [
    ['acquise', 'var(--good)'],
    ['progres', 'var(--mid)'],
    ['reprendre', 'var(--low)'],
  ] as const) {
    const part = total ? (totals[key] / total) * C : 0;
    if (!part) continue;
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', '52');
    c.setAttribute('cy', '52');
    c.setAttribute('r', String(R));
    c.setAttribute('fill', 'none');
    c.setAttribute('stroke', color);
    c.setAttribute('stroke-width', '15');
    c.setAttribute('stroke-dasharray', `${Math.max(0, part - 1.5)} ${C}`);
    c.setAttribute('stroke-dashoffset', String(-offset));
    c.setAttribute('transform', 'rotate(-90 52 52)');
    svg.append(c);
    offset += part;
  }
  const label = document.createElementNS(NS, 'text');
  label.setAttribute('x', '52');
  label.setAttribute('y', '58');
  label.setAttribute('text-anchor', 'middle');
  label.setAttribute('class', 'skills-ring-text');
  label.textContent = total ? `${Math.round((totals.acquise / total) * 100)} %` : '–';
  svg.append(label);
  return svg;
}

function overviewBlock(page: SkillsPage, child: Child): HTMLElement {
  const t = page.overview.totals;
  const total = t.acquise + t.progres + t.reprendre;
  if (!total)
    return h(
      'section.block',
      emptyState(
        'Pas encore de compétence évaluée',
        'Dès qu’un professeur évalue des compétences sur ÉcoleDirecte, elles apparaissent ici.',
      ),
    );
  const legend = (cls: string, label: string, n: number) =>
    h('li', h(`i.skill-dot.is-${cls}`), h('span', label), h('b.num', String(n)));
  return h(
    'section.block.skills-overview',
    sectionHead(state.session?.me?.role === 'parent' ? `Où en est ${child.name}` : 'Où tu en es'),
    h(
      'div.skills-ring',
      ring(t),
      h(
        'ul.skills-legend',
        legend('acquise', 'Acquises', t.acquise),
        legend('progres', 'En cours', t.progres),
        legend('reprendre', 'À reprendre', t.reprendre),
      ),
    ),
    h(
      'p.hint',
      'Le niveau vient des évaluations ÉcoleDirecte des quatre derniers mois. Le travail fait ici nuance une compétence sans la remplacer.',
    ),
  );
}

function bar(value: number | null, label: string, cls: string): HTMLElement {
  return h(
    'span.skill-bar',
    { role: 'img', 'aria-label': label },
    h(`i.${cls}`, { style: { width: `${Math.round(Math.max(0, Math.min(1, value ?? 0)) * 100)}%` } }),
  );
}

function skillRow(skill: SkillRow): HTMLElement {
  const trend =
    skill.progress === 'up'
      ? 'en progrès'
      : skill.progress === 'down'
        ? 'en baisse'
        : skill.progress === 'flat'
          ? 'stable'
          : '';
  const work = skill.work
    ? `${skill.work.right} sur ${skill.work.total} réussies`
    : skill.sheet
      ? 'pas encore travaillée'
      : '';
  return h(
    'li.skill-row',
    h('div.skill-head', h('b', skill.label), h(`span.chip.skill-status.is-${skill.status}`, STATUS_TEXT[skill.status])),
    h(
      'div.skill-lines',
      h('span', 'Évaluations'),
      bar((skill.level - 1) / 3, `Niveau ${skill.level} sur 4`, `is-${skill.status}`),
      h(
        'span.skill-note',
        `Niveau ${skill.level}/4${skill.evaluated ? ` · ${day(skill.evaluated)}` : ''}${trend ? ` · ${trend}` : ''}`,
      ),
      skill.sheet && h('span', 'Dans Orbite'),
      skill.sheet &&
        bar(
          skill.work && skill.work.total ? skill.work.right / skill.work.total : 0,
          work || 'rien de fait',
          'is-work',
        ),
      skill.sheet && h('span.skill-note', work),
    ),
  );
}

function subjectCard(child: Child, subject: SubjectOverview, actions: Actions, first: boolean): HTMLElement {
  const open = openSubjects.get(child.id) ?? new Set<string>();
  openSubjects.set(child.id, open);
  if (first && !open.has('__init')) {
    open.add('__init');
    if (subject.counts.reprendre > 0) open.add(subject.id);
  }
  const isOpen = open.has(subject.id);
  const trend =
    subject.trend === null || Math.abs(subject.trend) < 0.05
      ? ''
      : subject.trend > 0
        ? `En hausse de ${subject.trend.toLocaleString('fr-FR')} pt`
        : `En baisse de ${Math.abs(subject.trend).toLocaleString('fr-FR')} pt`;
  const summary = [subject.counts.reprendre ? `${subject.counts.reprendre} à reprendre` : 'Rien à reprendre', trend]
    .filter(Boolean)
    .join(' · ');
  return h(
    `section.card.skill-subject${isOpen ? '.is-open' : ''}`,
    h(
      'button.skill-subject-head',
      {
        type: 'button',
        'aria-expanded': String(isOpen),
        onclick: () => {
          if (isOpen) open.delete(subject.id);
          else open.add(subject.id);
          actions.rerender();
        },
      },
      h(
        'span.skill-subject-title',
        h('b.num', pretty(subject)),
        subject.average !== null &&
          h('span.skill-average', h('b.num', subject.average.toLocaleString('fr-FR')), h('small', ' / 20')),
      ),
      h(
        'span.skill-strip',
        { role: 'img', 'aria-label': `${subject.skills.length} compétences évaluées` },
        subject.skills.map((s) => h(`i.is-${s.status}`)),
      ),
      h('span.skill-summary', summary),
    ),
    isOpen &&
      h(
        'ul.skill-list',
        subject.skills.length ? subject.skills.map(skillRow) : [h('li.hint', 'Notes sans compétence évaluée.')],
      ),
  );
}

function subjectsBlock(page: SkillsPage, child: Child, actions: Actions): HTMLElement | null {
  const subjects = page.overview.subjects.filter((s) => s.skills.length > 0);
  if (!subjects.length) return null;
  return h(
    'section.block',
    sectionHead('Par matière'),
    h('p.hint', 'Un carré par compétence évaluée. Touche une matière pour voir le détail.'),
    subjects.map((s, i) => subjectCard(child, s, actions, i === 0)),
  );
}

/* ---------- Fiches de travail ---------- */

const REASON = {
  new: 'Nouvelle compétence à travailler',
  due: 'À revoir aujourd’hui',
  review: 'Révision pour garder le niveau',
} as const;

function exerciseBlock(title: string, x: { consigne: string; indice: string; corrige: string }): HTMLElement {
  return h(
    'div.sheet-exercise',
    h('b', title),
    h('p', x.consigne),
    h('details', h('summary', 'Un indice'), h('p', x.indice)),
    h('details', h('summary', 'Voir la correction'), h('p', x.corrige)),
  );
}

function sheetBody(child: Child, item: TodoItem, sheet: SheetView, actions: Actions): HTMLElement {
  const c = sheet.content;
  const parent = state.session?.me?.role === 'parent';
  return h(
    'div.sheet',
    h('p.sheet-goal', c.objectif),
    h(
      'div.sheet-part',
      h('b', 'À retenir'),
      h(
        'ul',
        c.rappel.map((r) => h('li', r)),
      ),
    ),
    exerciseBlock('Exercice guidé', c.guide),
    c.autonomes.map((x, i) => exerciseBlock(`À toi ${c.autonomes.length > 1 ? i + 1 : ''}`.trim(), x)),
    h(
      'div.sheet-part',
      h('b', 'Astuces'),
      h(
        'ul',
        c.astuces.map((r) => h('li', r)),
      ),
    ),
    h('p.sheet-cheer', c.encouragement),
    h(
      'p.sheet-source',
      sheet.via === 'claude'
        ? `Fiche écrite pour ${parent ? child.name : 'toi'} par Claude le ${new Date(sheet.generated).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}, d’après le programme de ${sheet.level} (${sheet.domain.toLowerCase()}). `
        : 'Fiche de secours, tirée du programme sans adaptation : une clé Claude dans les Réglages permet de l’écrire sur mesure. ',
      h('a', { href: sheet.reference, target: '_blank', rel: 'noopener noreferrer' }, 'Repères officiels (Éduscol)'),
    ),
    h(
      'div.sheet-actions',
      state.session?.me?.role === 'child' &&
        h(
          'button.button.button-primary',
          { type: 'button', onclick: () => actions.go('train') },
          icon('bolt', 18),
          'Faire le module',
        ),
      h(
        'button.button',
        {
          type: 'button',
          onclick: () => loadSheet(child, item.key, actions, true),
        },
        icon('refresh', 18),
        'Réécrire la fiche',
      ),
    ),
  );
}

function todoCard(child: Child, item: TodoItem, actions: Actions): HTMLElement {
  const id = `${child.id}|${item.key}`;
  const isOpen = openSheets.has(id);
  const entry = sheets.get(id);
  if (isOpen && !entry) loadSheet(child, item.key, actions);
  const e = sheets.get(id);
  return h(
    `section.card.todo${isOpen ? '.is-open' : ''}${item.done ? '.is-done' : ''}`,
    h(
      'div.todo-top',
      h('span.chip', SUBJECT_LABEL[item.subject]),
      item.done
        ? h('span.chip.skill-status.is-acquise', 'Fait aujourd’hui')
        : h('span.todo-reason', REASON[item.reason]),
    ),
    h('h3.todo-title', item.label),
    isOpen
      ? [
          e?.error && h('p.inline-error', e.error),
          e?.loading && !e.value && h('p.hint', 'Claude prépare la fiche…'),
          e?.value && sheetBody(child, item, e.value, actions),
          h(
            'button.link-button',
            {
              type: 'button',
              onclick: () => {
                openSheets.delete(id);
                // Une fiche en erreur est relue à la prochaine ouverture.
                if (!sheets.get(id)?.value) sheets.delete(id);
                actions.rerender();
              },
            },
            'Replier la fiche',
          ),
        ]
      : h(
          'button.button.button-wide',
          {
            type: 'button',
            onclick: () => {
              openSheets.add(id);
              actions.rerender();
            },
          },
          icon('file', 18),
          'Voir la fiche',
        ),
  );
}

function aidsBlock(page: SkillsPage, child: Child, actions: Actions): HTMLElement | null {
  if (!page.aidOptions) return null;
  const options = page.aidOptions;
  const chosen = new Set(page.aids);
  return h(
    'section.block',
    sectionHead(`Adapter les fiches à ${child.name}`),
    h(
      'p.hint',
      'Ce que tu coches guide la rédaction des fiches : consignes, exemples, rythme. Aucune donnée de santé.',
    ),
    aidError && h('p.inline-error', aidError),
    h(
      'div.aid-list',
      Object.entries(options).map(([id, text]) =>
        h(
          `button.chip.aid${chosen.has(id) ? '.is-on' : ''}`,
          {
            type: 'button',
            'aria-pressed': String(chosen.has(id)),
            onclick: () => {
              aidError = null;
              const next = new Set(chosen);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              const entry = pages.get(child.id);
              api.skills
                .aids(child.id, [...next])
                .then(({ aids }) => {
                  if (entry?.value) entry.value.aids = aids;
                  // Les fiches se réécrivent à la prochaine ouverture : le profil a changé.
                  for (const key of [...sheets.keys()]) if (key.startsWith(`${child.id}|`)) sheets.delete(key);
                })
                .catch((e) => {
                  aidError = message(e, 'Enregistrement impossible.');
                })
                .finally(actions.rerender);
            },
          },
          `${child.name} ${text}`,
        ),
      ),
    ),
  );
}

export function skillsView(child: Child, actions: Actions): HTMLElement {
  const page = pageOf(child, actions);
  const entry = pages.get(child.id);
  const me = state.session?.me;
  return h(
    'div.screen',
    { style: accent(child.id) },
    sky({
      title: 'Compétences',
      subtitle: me?.role === 'parent' ? child.name : child.className,
      extra: [childSwitcher(actions)],
    }),
    h(
      'div.flow',
      entry?.error && !page && h('p.inline-error', entry.error),
      !page && !entry?.error && h('div.skeleton.skeleton-row'),
      page && overviewBlock(page, child),
      page && subjectsBlock(page, child, actions),
      page &&
        h(
          'section.block',
          sectionHead('Le travail proposé'),
          h(
            'p.hint',
            page.writing
              ? `Chaque fiche est écrite pour ${me?.role === 'parent' ? child.name : 'toi'} à partir des résultats et des programmes de l’Éducation nationale, puis mise à jour à l’usage.`
              : 'Les fiches s’appuient sur les programmes de l’Éducation nationale. Avec une clé Claude (Réglages), elles seront écrites sur mesure.',
          ),
          page.todo.length
            ? page.todo.map((t) => todoCard(child, t, actions))
            : emptyState('Rien à travailler aujourd’hui', 'Les compétences évaluées sont toutes bien tenues.'),
        ),
      page && aidsBlock(page, child, actions),
    ),
  );
}

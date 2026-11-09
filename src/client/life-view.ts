/**
 * Vie scolaire : absences, retards, punitions, sanctions et encouragements lus
 * sur ÉcoleDirecte. Un élève ne voit que les siens ; les parents voient tout.
 */
import { h, icon } from './dom.ts';
import { monthYear, relativeDay } from './format.ts';
import { accent, childSwitcher, emptyState, sectionHead, sky, type Actions } from './views.ts';
import { state } from './state.ts';
import type { Child, LifeEvent, LifeKind, SchoolLife } from '../shared/types.ts';

const KIND: Record<LifeKind, { label: string; plural: string; icon: string }> = {
  absence: { label: 'Absence', plural: 'Absences', icon: 'absent' },
  retard: { label: 'Retard', plural: 'Retards', icon: 'clock' },
  punition: { label: 'Punition', plural: 'Punitions', icon: 'flag' },
  sanction: { label: 'Sanction', plural: 'Sanctions', icon: 'flag' },
  encouragement: { label: 'Encouragement', plural: 'Encouragements', icon: 'star' },
  autre: { label: 'Événement', plural: 'Autres', icon: 'shield' },
};

const DAY = 86400000;
const recent = (e: LifeEvent, days: number) => !!e.date && Date.now() - Date.parse(e.date + 'T12:00:00Z') <= days * DAY;
const isSanction = (e: LifeEvent) => e.kind === 'punition' || e.kind === 'sanction';

/** Vie scolaire d'un élève : chargée à la demande, `null` tant qu'elle n'est pas là. */
export function lifeOf(childId: string, actions: Actions): SchoolLife | null {
  const entry = state.lives.get(childId);
  if (!entry) actions.loadLife(childId);
  return entry?.value ?? null;
}

/** Pastilles de la carte enfant (accueil famille) : sanctions récentes, absences à justifier. */
export function lifeFacts(child: Child, actions: Actions): HTMLElement[] {
  const life = lifeOf(child.id, actions);
  if (!life) return [];
  const sanctions = life.events.filter((e) => isSanction(e) && recent(e, 30)).length;
  const toJustify = life.events.filter(
    (e) => (e.kind === 'absence' || e.kind === 'retard') && e.justified === false,
  ).length;
  return [
    sanctions > 0 && h('span.fact.fact-alert', `${sanctions} sanction${sanctions > 1 ? 's' : ''}`),
    toJustify > 0 && h('span.fact.fact-warn', `${toJustify} à justifier`),
  ].filter((x): x is HTMLElement => !!x);
}

function justification(e: LifeEvent): HTMLElement | null {
  if (e.kind !== 'absence' && e.kind !== 'retard') return null;
  if (e.justified === null) return h('span.chip.chip-warn', 'En attente');
  return e.justified
    ? h('span.chip', 'Justifié' + (e.kind === 'absence' ? 'e' : ''))
    : h('span.chip.chip-alert', 'À justifier');
}

function lifeRow(e: LifeEvent, child?: Child): HTMLElement {
  const k = KIND[e.kind];
  const head = e.kind === 'absence' || e.kind === 'retard' ? k.label : e.title || e.type || k.label;
  const size = e.kind === 'absence' || e.kind === 'retard' ? e.title : e.todo;
  return h(
    `li.life-item.kind-${e.kind}`,
    child && { style: accent(child.id) },
    h('span.life-icon', icon(k.icon, 20)),
    h(
      'div.life-main',
      h('p.life-head', h('b', head), size && h('span.life-size', size), justification(e)),
      e.reason && h('p.life-reason', e.reason),
      h(
        'p.life-meta',
        child && h('span.child-tag', child.name),
        e.date && h('span', relativeDay(e.date)),
        e.kind !== 'absence' && e.kind !== 'retard' && e.type && e.type !== head && h('span', e.type),
        e.by && h('span', e.by),
      ),
      e.when && h('p.life-when', e.when),
      e.comment && h('p.life-comment', e.comment),
    ),
  );
}

/** Carte de l'accueil élève : le mois écoulé en une ligne, ou ce qui s'est passé. */
export function lifeCard(child: Child, actions: Actions): HTMLElement {
  const entry = state.lives.get(child.id);
  const life = lifeOf(child.id, actions);
  const month = (life?.events ?? []).filter((e) => recent(e, 30));
  return h(
    'section.block',
    sectionHead(
      'Vie scolaire',
      h('button.link-button', { type: 'button', onclick: () => actions.go('life', child.id) }, 'Détail'),
    ),
    entry?.error
      ? h('p.inline-note', entry.error)
      : !life
        ? h('div.skeleton.skeleton-row')
        : month.length === 0
          ? h(
              'button.life-calm',
              { type: 'button', onclick: () => actions.go('life', child.id) },
              icon('shield', 22),
              h(
                'span',
                h('b', 'Rien à signaler ce mois-ci'),
                h('small', 'Aucune absence, aucun retard, aucune sanction.'),
              ),
            )
          : h(
              'ul.life-list',
              month.slice(0, 3).map((e) => lifeRow(e)),
            ),
  );
}

/** Accueil famille : les deux dernières semaines, tous enfants confondus. */
export function familyLifeBlock(children: Child[], actions: Actions): HTMLElement | null {
  const rows = children
    .flatMap((c) => (lifeOf(c.id, actions)?.events ?? []).filter((e) => recent(e, 14)).map((e) => ({ c, e })))
    .sort((a, b) => (b.e.date ?? '').localeCompare(a.e.date ?? ''));
  if (!rows.length) return null;
  return h(
    'section.block',
    sectionHead(
      'Vie scolaire',
      h('button.link-button', { type: 'button', onclick: () => actions.go('life') }, 'Tout voir'),
    ),
    h(
      'ul.life-list',
      rows.slice(0, 4).map(({ c, e }) => lifeRow(e, c)),
    ),
  );
}

export function lifeView(child: Child, actions: Actions): HTMLElement {
  const entry = state.lives.get(child.id);
  const life = lifeOf(child.id, actions);
  const parent = state.session?.me?.role === 'parent';
  const events = life?.events ?? [];
  const count = (kinds: LifeKind[]) => events.filter((e) => kinds.includes(e.kind)).length;
  const toJustify = events.filter((e) => (e.kind === 'absence' || e.kind === 'retard') && e.justified === false).length;
  const tiles: [string, number, string, string | null][] = [
    ['absence', count(['absence']), 'Absences', toJustify ? `${toJustify} à justifier` : null],
    ['retard', count(['retard']), 'Retards', null],
    ['punition', count(['punition', 'sanction']), 'Sanctions', null],
    ['encouragement', count(['encouragement']), 'Encouragements', null],
  ];
  const months = new Map<string, LifeEvent[]>();
  for (const e of events) {
    const key = e.date ? e.date.slice(0, 7) : 'sans-date';
    months.set(key, [...(months.get(key) ?? []), e]);
  }
  const monthLabel = (key: string) => (key === 'sans-date' ? 'Date non précisée' : monthYear(key));
  return h(
    'div.screen.narrow.life',
    { style: accent(child.id) },
    sky({
      title: 'Vie scolaire',
      subtitle: parent ? child.name : 'Absences, retards, sanctions et encouragements',
      back: parent ? null : () => actions.go('home'),
      extra: [childSwitcher(actions)],
    }),
    entry?.error &&
      h(
        'div.inline-error',
        entry.error,
        h('button.link-button', { type: 'button', onclick: () => actions.loadLife(child.id, true) }, 'Réessayer'),
      ),
    !life &&
      !entry?.error &&
      h(
        'div.bag-loading',
        [0, 1, 2].map(() => h('div.skeleton')),
      ),
    life &&
      h(
        'dl.life-tiles',
        tiles.map(([kind, n, label, note]) =>
          h(
            `div.life-tile.kind-${kind}${n === 0 ? '.is-zero' : ''}`,
            h('dt', label),
            h('dd', String(n)),
            note && h('small', note),
          ),
        ),
      ),
    life &&
      (events.length === 0
        ? emptyState(
            'Rien à signaler',
            parent
              ? 'ÉcoleDirecte n’indique ni absence, ni retard, ni sanction cette année.'
              : 'Aucune absence, aucun retard, aucune sanction cette année. Continue comme ça !',
          )
        : h(
            'div.days',
            [...months].map(([key, list]) =>
              h(
                'section.block',
                sectionHead(monthLabel(key), h('span.counter', String(list.length))),
                h(
                  'ul.life-list',
                  list.map((e) => lifeRow(e)),
                ),
              ),
            ),
          )),
    h(
      'p.footnote',
      'Lu sur ÉcoleDirecte, sans rien modifier. Les absences se justifient sur ÉcoleDirecte ; ce qui est masqué par le collège reste masqué ici.',
    ),
  );
}

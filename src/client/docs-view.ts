/**
 * Documents de l'établissement (parents) : bulletins, documents de vie scolaire,
 * administratifs et factures publiés sur ÉcoleDirecte. Lecture seule ; chaque
 * lien est signé, valable quelques minutes sur cet appareil.
 */
import { api, ApiError } from './api.ts';
import { h, icon } from './dom.ts';
import { capitalize, monthYear, relativeDay } from './format.ts';
import { state } from './state.ts';
import { accent, emptyState, sectionHead, sky, type Actions } from './views.ts';
import type { DocKind, SchoolDocument } from '../shared/types.ts';

const KIND: Record<DocKind, string> = {
  bulletin: 'Bulletins',
  vie: 'Vie scolaire',
  admin: 'Administratif',
  facture: 'Factures',
};

/** Charge (ou recharge, liens expirés) la liste des documents. */
export function loadDocs(rerender: () => void, refresh = false): void {
  const current = state.docs;
  if (current.loading) return;
  current.loading = true;
  current.error = null;
  if (refresh) queueMicrotask(rerender);
  api
    .documents(refresh)
    .then((list) => {
      current.value = list;
      current.time = Date.now();
    })
    .catch((e) => {
      current.error = e instanceof ApiError ? e.message : 'Documents indisponibles.';
    })
    .finally(() => {
      current.loading = false;
      rerender();
    });
}

/** Documents à jour : les liens signés expirent au bout de 15 minutes. */
function docs(actions: Actions) {
  const d = state.docs;
  if (!d.loading && !d.error && (!d.value || Date.now() - (d.time ?? 0) > 10 * 60000)) loadDocs(actions.rerender);
  return d;
}

function docRow(doc: SchoolDocument): HTMLElement {
  const child = state.data?.children.find((c) => c.id === doc.childId);
  return h(
    'li',
    h(
      'a.mail-file.doc-row',
      { href: doc.url ?? '#', target: '_blank', rel: 'noopener noreferrer', style: child ? accent(child.id) : null },
      h('span.mail-file-icon', icon('file', 20)),
      h(
        'span.doc-main',
        h('span.mail-file-name', doc.name),
        h(
          'small',
          [child?.name, doc.date && capitalize(relativeDay(doc.date))].filter(Boolean).join(' · ') || KIND[doc.kind],
        ),
      ),
      icon('open', 18),
    ),
  );
}

/** Accueil famille : les deux derniers documents publiés (rien si la rubrique est vide ou indisponible). */
export function familyDocsBlock(actions: Actions): HTMLElement | null {
  const d = docs(actions);
  const items = d.value?.items ?? [];
  if (!items.length) return null;
  // Toujours visible quand le collège a publié quelque chose : c'est l'entrée vers la liste.
  const recent = items.slice(0, 2);
  return h(
    'section.block',
    sectionHead(
      'Documents',
      h('button.link-button', { type: 'button', onclick: () => actions.go('docs') }, 'Tout voir'),
    ),
    h('ul.mail-files', recent.map(docRow)),
  );
}

export function docsView(actions: Actions): HTMLElement {
  const d = docs(actions);
  const list = d.value;
  const items = (list?.items ?? []).filter((x) => state.docsKind === 'all' || x.kind === state.docsKind);
  const kinds = [...new Set((list?.items ?? []).map((x) => x.kind))];
  return h(
    'div.screen.narrow.docs',
    sky({
      title: 'Documents',
      subtitle: 'Bulletins et documents du collège',
      back: () => actions.go('home'),
    }),
    kinds.length > 1 &&
      h(
        'div.class-pick',
        { role: 'tablist', 'aria-label': 'Rubrique' },
        (['all', ...kinds] as const).map((k) =>
          h(
            `button.chip-button${state.docsKind === k ? '.is-active' : ''}`,
            {
              type: 'button',
              role: 'tab',
              'aria-selected': String(state.docsKind === k),
              onclick: () => {
                state.docsKind = k;
                actions.rerender();
              },
            },
            k === 'all' ? 'Tout' : KIND[k],
          ),
        ),
      ),
    d.error &&
      h(
        'div.inline-error',
        d.error,
        h('button.link-button', { type: 'button', onclick: () => loadDocs(actions.rerender, true) }, 'Réessayer'),
      ),
    !list &&
      !d.error &&
      h(
        'ul.task-list.is-loading',
        [0, 1, 2].map(() => h('li.skeleton')),
      ),
    list?.unavailable &&
      emptyState(
        'Documents indisponibles',
        'ÉcoleDirecte ne donne pas accès à cette rubrique pour le moment. Les bulletins restent consultables sur ÉcoleDirecte.',
      ),
    list &&
      !list.unavailable &&
      (items.length === 0
        ? emptyState('Aucun document', 'Le collège n’a encore rien publié cette année.')
        : h(
            'div.days',
            groupByMonth(items).map(([label, rows]) =>
              h('section.block', sectionHead(label), h('ul.mail-files', rows.map(docRow))),
            ),
          )),
    h(
      'p.footnote',
      'Lus sur ÉcoleDirecte, sans rien modifier. Un document qui ne s’ouvre pas ici reste disponible sur ÉcoleDirecte.',
    ),
  );
}

function groupByMonth(items: SchoolDocument[]): [string, SchoolDocument[]][] {
  const out = new Map<string, SchoolDocument[]>();
  for (const x of items) {
    const key = x.date ? x.date.slice(0, 7) : '';
    out.set(key, [...(out.get(key) ?? []), x]);
  }
  return [...out].map(([key, rows]) => [key ? monthYear(key) : 'Date non précisée', rows]);
}

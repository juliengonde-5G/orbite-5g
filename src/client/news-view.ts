/**
 * Nouveautés et signalements : l'historique des versions, un bandeau « quoi de neuf »
 * après une mise à jour, le formulaire pour signaler un problème ou proposer une
 * idée, et, pour le parent administrateur, la liste des signalements reçus.
 */
import { api, ApiError } from './api.ts';
import { h, icon } from './dom.ts';
import { state } from './state.ts';
import { sheet } from './settings.ts';
import { emptyState, sectionHead, sky } from './views.ts';
import {
  REPORT_KINDS,
  REPORT_LABEL,
  REPORT_MAX,
  RELEASES,
  releasesSince,
  type ReportKind,
  type ReportView,
} from '../shared/releases.ts';

/** Ce dont ces écrans ont besoin de l'application. */
export interface NewsActions {
  go(route: string): void;
  rerender(): void;
  toast(message: string): void;
}

const SEEN_KEY = 'orbite.version-vue';

/** Dernière version dont cet appareil a vu les nouveautés ; `null` à la première visite. */
function seenVersion(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

function markSeen(version: string): void {
  try {
    localStorage.setItem(SEEN_KEY, version);
  } catch {}
}

const dayText = (date: string) =>
  new Date(date + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

/** Bandeau d'accueil après une mise à jour ; une première visite n'annonce rien. */
export function newsBanner(actions: Pick<NewsActions, 'go' | 'rerender'>): HTMLElement | null {
  const current = state.session?.version;
  if (!current) return null;
  const seen = seenVersion();
  if (seen === null) {
    markSeen(current);
    return null;
  }
  const latest = releasesSince(seen)[0];
  if (!latest || latest.version !== current) return null;
  return h(
    'section.block.news-banner',
    h('div.news-banner-text', h('b', `Orbite ${latest.version} : ${latest.title}`), h('span', latest.notes[0] ?? '')),
    h(
      'div.row-actions',
      h('button.button.button-primary', { type: 'button', onclick: () => actions.go('news') }, 'Voir les nouveautés'),
      h(
        'button.link-button',
        {
          type: 'button',
          onclick: () => {
            markSeen(current);
            actions.rerender();
          },
        },
        'Plus tard',
      ),
    ),
  );
}

/** Écran « Nouveautés » : toutes les versions, la plus récente d'abord. */
export function newsView(actions: NewsActions): HTMLElement {
  const current = state.session?.version;
  if (current) markSeen(current);
  return h(
    'div.screen.narrow.news',
    sky({ title: 'Nouveautés', subtitle: current ? `Orbite ${current}` : null, back: () => actions.go('help') }),
    h(
      'div.flow',
      RELEASES.map((r, i) =>
        h(
          'section.block.release',
          sectionHead(`Version ${r.version}`, i === 0 && h('span.counter.counter-accent', 'Dernière')),
          h('p.release-title', h('b', r.title), h('span.release-date', dayText(r.date))),
          h(
            'ul.release-notes',
            r.notes.map((n) => h('li', n)),
          ),
        ),
      ),
      h(
        'section.block',
        h('p.hint', 'Un souci, une idée ? Dis-le ici : le parent administrateur reçoit ton message.'),
        h(
          'button.button.button-wide',
          { type: 'button', onclick: () => reportSheet(actions) },
          icon('flag', 18),
          'Signaler un problème',
        ),
      ),
    ),
  );
}

/** Feuille « Signaler un problème, proposer une idée ». */
export function reportSheet(actions: NewsActions): void {
  sheet('Signaler un problème', (close) => {
    let kind: ReportKind = 'bug';
    const kinds = h(
      'div.segmented',
      { role: 'radiogroup', 'aria-label': 'Type de message' },
      REPORT_KINDS.map((k) =>
        h(
          `button${k === kind ? '.is-active' : ''}`,
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(k === kind),
            onclick: (e: Event) => {
              kind = k;
              for (const b of kinds.querySelectorAll('button')) {
                b.classList.toggle('is-active', b === e.currentTarget);
                b.setAttribute('aria-checked', String(b === e.currentTarget));
              }
            },
          },
          REPORT_LABEL[k],
        ),
      ),
    );
    const text = h('textarea.text-input.report-text', {
      rows: '5',
      maxlength: String(REPORT_MAX),
      placeholder: 'Ce que tu as fait, ce que tu attendais, ce qui s’est passé…',
      'aria-label': 'Ton message',
    });
    const error = h('p.form-error', { role: 'alert' });
    const body = h(
      'form.sheet-body',
      {
        onsubmit: async (e: Event) => {
          e.preventDefault();
          error.textContent = '';
          body.classList.add('is-busy');
          try {
            await api.report(kind, text.value, location.hash.replace('#', '').split('/')[0] || 'accueil');
            close();
            actions.toast('Merci, c’est envoyé.');
          } catch (err) {
            error.textContent = err instanceof ApiError ? err.message : 'Envoi impossible, réessaie.';
          } finally {
            body.classList.remove('is-busy');
          }
        },
      },
      h(
        'p.sheet-lead',
        'Pas de mot de passe ni de note dans ton message : le texte est lu par le parent administrateur.',
      ),
      kinds,
      text,
      error,
      h(
        'div.sheet-actions',
        h('button.button', { type: 'button', onclick: close }, 'Annuler'),
        h('button.button.button-primary', { type: 'submit' }, 'Envoyer'),
      ),
    );
    queueMicrotask(() => text.focus());
    return body;
  });
}

function reportRow(item: ReportView, actions: NewsActions): HTMLElement {
  const run = (call: Promise<{ items: ReportView[]; open: number }>) =>
    call
      .then((list) => {
        state.reports = { value: list, loading: false, error: null, time: Date.now() };
      })
      .catch((e) => actions.toast(e instanceof ApiError ? e.message : 'Action impossible.'))
      .finally(actions.rerender);
  return h(
    `li.report-row${item.done ? '.is-done' : ''}`,
    h(
      'p.report-meta',
      h('b', item.by),
      ` · ${REPORT_LABEL[item.kind].toLowerCase()} · ${new Date(item.at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} · ${item.screen} · v${item.version}`,
    ),
    h('p.report-text', item.text),
    h(
      'div.row-actions',
      h(
        'button.link-button',
        { type: 'button', onclick: () => run(api.admin.resolveReport(item.id, !item.done)) },
        item.done ? 'Rouvrir' : 'Marquer traité',
      ),
      item.done &&
        h('button.link-button', { type: 'button', onclick: () => run(api.admin.removeReport(item.id)) }, 'Supprimer'),
    ),
  );
}

/** Signalements reçus (parent administrateur), relus à chaque ouverture de l'écran Moi. */
export function reportsBlock(actions: NewsActions): HTMLElement {
  const r = state.reports;
  // Relue à chaque ouverture de l'écran (au plus toutes les 30 s), y compris après une erreur.
  if (!r.loading && Date.now() - (r.time ?? 0) > 30000) {
    r.loading = true;
    api.admin
      .reports()
      .then((list) => {
        r.value = list;
        r.error = null;
      })
      .catch((e) => {
        r.error = e instanceof ApiError ? e.message : 'Signalements indisponibles.';
      })
      .finally(() => {
        r.loading = false;
        r.time = Date.now();
        actions.rerender();
      });
  }
  const items = r.value?.items ?? [];
  return h(
    'section.block',
    sectionHead(
      'Signalements',
      r.value && r.value.open > 0 ? h('span.counter.counter-accent', String(r.value.open)) : undefined,
    ),
    r.error && h('p.inline-error', r.error),
    r.value && items.length === 0 && emptyState('Aucun signalement', 'Les messages de la famille arriveront ici.'),
    items.length > 0 &&
      h(
        'ul.report-list',
        items.map((item) => reportRow(item, actions)),
      ),
  );
}

/** Écran Aide : nouveautés, signalement et, pour le parent administrateur, les signalements reçus. */
export function helpView(actions: NewsActions): HTMLElement {
  const me = state.session?.me;
  const row = (ico: string, title: string, text: string, onclick: () => void) =>
    h(
      'button.help-row',
      { type: 'button', onclick },
      h('span.help-icon', icon(ico, 22)),
      h('span.help-text', h('b', title), h('small', text)),
      icon('next', 18),
    );
  return h(
    'div.screen.narrow',
    sky({ title: 'Aide', subtitle: state.session?.version ? `Orbite ${state.session.version}` : null }),
    h(
      'div.flow',
      h(
        'section.block',
        row('star', 'Nouveautés', 'Ce qui a changé dans chaque version.', () => actions.go('news')),
        row('flag', 'Signaler un problème', 'Un souci, une idée : le parent administrateur reçoit ton message.', () =>
          reportSheet(actions),
        ),
      ),
      me?.role === 'parent' && me.admin && reportsBlock(actions),
    ),
  );
}

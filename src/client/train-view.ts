/**
 * Soutien scolaire : carte d'accueil, module de cinq questions et correction.
 *
 * L'élève voit « Ton entraînement du jour » (jusqu'à trois modules de dix minutes)
 * et répond depuis son profil. Le parent active le soutien pour chaque enfant et
 * suit un bilan de quatorze jours, sans pouvoir répondre à sa place. Rien n'est
 * jamais comparé entre enfants.
 */
import { api, ApiError } from './api.ts';
import { h, icon } from './dom.ts';
import { state } from './state.ts';
import { accent, emptyState, sectionHead, sky, type Actions } from './views.ts';
import { SUBJECT_LABEL, type ModuleResult, type ModuleView, type SupportStatus } from '../shared/support.ts';
import type { Child } from '../shared/types.ts';

export interface TrainRun {
  childId: string;
  module: ModuleView | null;
  index: number;
  answers: (number | null)[];
  startedAt: number;
  result: ModuleResult | null;
  loading: boolean;
  error: string | null;
}

const message = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/** Statut du soutien d'un élève, chargé une fois puis relu à la demande. */
function statusOf(child: Child, actions: Actions): SupportStatus | null {
  const entry = state.support.get(child.id) ?? { value: null, loading: false, error: null };
  state.support.set(child.id, entry);
  if (!entry.value && !entry.loading && !entry.error) {
    entry.loading = true;
    api.support
      .status(child.id)
      .then((value) => (entry.value = value))
      .catch((e) => (entry.error = message(e, 'Soutien indisponible.')))
      .finally(() => {
        entry.loading = false;
        actions.rerender();
      });
  }
  return entry.value;
}

function reloadStatus(childId: string, status?: SupportStatus): void {
  state.support.set(childId, { value: status ?? null, loading: false, error: null });
}

const percent = (value: number | null) => (value === null ? '' : ` · ${Math.round(value * 100)} % de réussite`);

function parentCard(child: Child, status: SupportStatus, actions: Actions): HTMLElement {
  const toggle = (enabled: boolean) => {
    api.support
      .enable(child.id, enabled)
      .then((next) => reloadStatus(child.id, next))
      .catch((e) => {
        const entry = state.support.get(child.id);
        if (entry) entry.error = message(e, 'Réglage impossible.');
      })
      .finally(actions.rerender);
  };
  return h(
    'section.block.train-card',
    sectionHead('Soutien scolaire'),
    h(
      'p.train-lead',
      status.enabled
        ? `${child.name} a droit à ${status.max} modules de ${status.minutes} minutes par jour au plus, choisis d’après ses compétences ÉcoleDirecte.`
        : `Un entraînement de ${status.minutes} minutes par jour en maths, français et anglais, choisi d’après les compétences ÉcoleDirecte de ${child.name}. Les exercices sont rédigés par Claude : seuls la matière, le niveau et l’intitulé de la compétence lui sont transmis, jamais un nom ni une note.`,
    ),
    !status.available &&
      h('p.inline-error', 'Ajoute une clé Claude dans Réglages pour que les exercices puissent être créés.'),
    status.enabled &&
      status.summary.modules > 0 &&
      h(
        'ul.train-summary',
        status.summary.subjects.map((s) =>
          h(
            'li',
            h('b', SUBJECT_LABEL[s.subject]),
            ` ${s.modules} module${s.modules > 1 ? 's' : ''}${percent(s.success)}`,
          ),
        ),
      ),
    status.enabled && status.summary.modules === 0 && h('p.train-lead', 'Aucun module terminé pour l’instant.'),
    h(
      'div.row-actions',
      h(
        'button.link-button',
        { type: 'button', onclick: () => toggle(!status.enabled) },
        status.enabled ? 'Désactiver le soutien' : 'Activer le soutien',
      ),
    ),
  );
}

/** Carte de l'accueil d'un élève : l'entraînement du jour pour lui, l'activation pour un parent. */
export function trainCard(child: Child, actions: Actions, asParent: boolean): HTMLElement | null {
  const status = statusOf(child, actions);
  if (!status) return null;
  if (asParent) return parentCard(child, status, actions);
  if (!status.enabled || !status.available) return null;
  if (status.plan.length === 0 && status.doneToday === 0) return null;
  return h(
    'section.block.train-card',
    { style: accent(child.id) },
    sectionHead('Ton entraînement du jour', h('span.counter', `${status.doneToday}/${status.max}`)),
    status.plan.length === 0
      ? h('p.train-lead', 'C’est fait pour aujourd’hui. À demain !')
      : h(
          'ul.train-list',
          status.plan.map((p) =>
            h(
              'li',
              h(
                'button.train-item',
                { type: 'button', onclick: () => begin(child, p.key, actions) },
                h('span.train-subject', SUBJECT_LABEL[p.subject]),
                h('span.train-label', p.label),
                h('span.train-go', `${status.minutes} min`, icon('next', 16)),
              ),
            ),
          ),
        ),
  );
}

function begin(child: Child, key: string, actions: Actions): void {
  const run: TrainRun = {
    childId: child.id,
    module: null,
    index: 0,
    answers: [],
    startedAt: Date.now(),
    result: null,
    loading: true,
    error: null,
  };
  state.train = run;
  actions.go('train', child.id);
  api.support
    .start(child.id, key)
    .then((module) => {
      run.module = module;
      run.answers = module.items.map(() => null);
      run.startedAt = Date.now();
    })
    .catch((e) => (run.error = message(e, 'Exercices indisponibles pour le moment.')))
    .finally(() => {
      run.loading = false;
      actions.rerender();
    });
}

function finish(run: TrainRun, actions: Actions): void {
  if (!run.module || run.loading) return;
  run.loading = true;
  run.error = null;
  actions.rerender();
  api.support
    .answer(run.childId, run.module.id, run.answers, (Date.now() - run.startedAt) / 1000)
    .then((result) => {
      run.result = result;
      reloadStatus(run.childId, result.status);
    })
    .catch((e) => (run.error = message(e, 'Correction impossible, réessaie.')))
    .finally(() => {
      run.loading = false;
      actions.rerender();
    });
}

function leave(actions: Actions): void {
  state.train = null;
  actions.go('home');
}

function resultBody(run: TrainRun, module: ModuleView, result: ModuleResult, actions: Actions): HTMLElement {
  const mood =
    result.right === result.total
      ? 'Sans faute !'
      : result.right >= result.total * 0.6
        ? 'Bien joué, la suite se précise.'
        : 'Ce n’est pas grave : on y revient bientôt, un peu plus doucement.';
  return h(
    'div.flow.train-run',
    h('p.train-score', h('b', `${result.right} sur ${result.total}`), h('span', mood)),
    h(
      'ol.train-review',
      module.items.map((item, i) => {
        const r = result.items[i]!;
        const given = run.answers[i];
        return h(
          `li.${r.correct ? 'is-right' : 'is-wrong'}`,
          h('p.train-q', item.q),
          h('p.train-a', icon(r.correct ? 'check' : 'close', 16), item.choices[r.answer] ?? ''),
          !r.correct &&
            typeof given === 'number' &&
            given >= 0 &&
            h('p.train-mine', `Ta réponse : ${item.choices[given] ?? '—'}`),
          r.explain && h('p.train-explain', r.explain),
        );
      }),
    ),
    h(
      'div.row-actions',
      h('button.button.button-primary', { type: 'button', onclick: () => leave(actions) }, 'Terminer'),
    ),
  );
}

function questionBody(run: TrainRun, module: ModuleView, actions: Actions): HTMLElement {
  const item = module.items[run.index]!;
  const last = run.index === module.items.length - 1;
  const chosen = run.answers[run.index] ?? null;
  return h(
    'div.flow.train-run',
    h(
      'div.train-progress',
      {
        role: 'progressbar',
        'aria-valuemin': '0',
        'aria-valuemax': String(module.items.length),
        'aria-valuenow': String(run.index + 1),
      },
      module.items.map((_, i) => h(`span${i <= run.index ? '.is-done' : ''}`)),
    ),
    h('p.train-step', `Question ${run.index + 1} sur ${module.items.length}`),
    h('h2.train-question', item.q),
    h(
      'div.train-choices',
      { role: 'radiogroup', 'aria-label': 'Réponses' },
      item.choices.map((choice, i) =>
        h(
          `button.train-choice${chosen === i ? '.is-chosen' : ''}`,
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(chosen === i),
            onclick: () => {
              run.answers[run.index] = i;
              actions.rerender();
            },
          },
          choice,
        ),
      ),
    ),
    run.error && h('p.inline-error', run.error),
    h(
      'div.row-actions',
      h(
        'button.button.button-primary',
        {
          type: 'button',
          disabled: chosen === null || run.loading,
          onclick: () => {
            if (last) return finish(run, actions);
            run.index += 1;
            actions.rerender();
          },
        },
        last ? (run.loading ? 'Correction…' : 'Voir mon résultat') : 'Suivant',
      ),
    ),
  );
}

export function trainView(child: Child, actions: Actions): HTMLElement {
  const run = state.train && state.train.childId === child.id ? state.train : null;
  const module = run?.module ?? null;
  return h(
    'div.screen.narrow.train',
    { style: accent(child.id) },
    sky({
      title: 'Entraînement',
      subtitle: module ? `${SUBJECT_LABEL[module.subject]} · ${module.label}` : null,
      back: () => leave(actions),
    }),
    !run && emptyState('Aucun module en cours', 'Reviens à l’accueil pour choisir ton entraînement du jour.'),
    run?.loading &&
      !module &&
      h(
        'div.flow',
        h('p.train-lead', 'Je prépare tes questions…'),
        h(
          'ul.task-list.is-loading',
          [0, 1, 2].map(() => h('li.skeleton')),
        ),
      ),
    run?.error &&
      !module &&
      h(
        'div.flow',
        h('p.inline-error', run.error),
        h('button.link-button', { type: 'button', onclick: () => leave(actions) }, 'Retour à l’accueil'),
      ),
    run && module && (run.result ? resultBody(run, module, run.result, actions) : questionBody(run, module, actions)),
  );
}

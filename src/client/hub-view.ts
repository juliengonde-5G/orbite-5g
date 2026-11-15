/**
 * Familles hébergées (administrateur de la plateforme) : inviter une famille,
 * suivre l'usage quotidien de la clé Claude partagée, régler un plafond ou
 * suspendre une famille. Aucune donnée d'une famille n'est visible ici : ni
 * profils, ni notes, ni identifiants.
 */
import { ApiError, hubApi } from './api.ts';
import { h } from './dom.ts';
import { state } from './state.ts';
import { sheet, type SettingsActions } from './settings.ts';
import { sectionHead } from './views.ts';
import type { FamilyView, HubOverview } from '../shared/hub.ts';

let overview: HubOverview | null = null;
let loading = false;
let failure: string | null = null;

const dayText = (time: number) => new Date(time).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });

function inviteSheet(actions: SettingsActions): void {
  sheet('Inviter une famille', (close) => {
    const label = h('input.text-input', {
      type: 'text',
      maxlength: '60',
      placeholder: 'Pour qui ? (ex. famille Martin)',
      'aria-label': 'Nom de l’invitation',
    });
    const error = h('p.form-error', { role: 'alert' });
    const result = h('div.sheet-section');
    const body = h(
      'form.sheet-body',
      {
        onsubmit: async (e: Event) => {
          e.preventDefault();
          error.textContent = '';
          body.classList.add('is-busy');
          try {
            const created = await hubApi.invite(label.value);
            overview = { families: created.families, invites: created.invites };
            const link = location.origin + created.path;
            result.replaceChildren(
              h('p.hint', 'Lien à envoyer à la famille. Il ne marche qu’une fois et reste valable sept jours.'),
              h('p.invite-link', link),
              h(
                'button.button.button-primary',
                {
                  type: 'button',
                  onclick: () =>
                    void navigator.clipboard
                      ?.writeText(link)
                      .then(() => actions.toast('Lien copié.'))
                      .catch(() => actions.toast('Copie impossible : sélectionne le lien.')),
                },
                'Copier le lien',
              ),
            );
            actions.rerender();
          } catch (err) {
            error.textContent = err instanceof ApiError ? err.message : 'Invitation impossible.';
          } finally {
            body.classList.remove('is-busy');
          }
        },
      },
      h(
        'p.sheet-lead',
        'Chaque famille a son propre espace chiffré et son propre lien. Elle connecte son compte ÉcoleDirecte ; la clé Claude reste la tienne, dans la limite d’un plafond quotidien.',
      ),
      label,
      error,
      result,
      h(
        'div.sheet-actions',
        h('button.button', { type: 'button', onclick: close }, 'Fermer'),
        h('button.button.button-primary', { type: 'submit' }, 'Créer l’invitation'),
      ),
    );
    queueMicrotask(() => label.focus());
    return body;
  });
}

function limitSheet(family: FamilyView, actions: SettingsActions): void {
  sheet(`Plafond de ${family.name}`, (close) => {
    const input = h('input.text-input', {
      type: 'number',
      min: '0',
      max: '500',
      inputmode: 'numeric',
      value: String(family.dailyLimit),
      'aria-label': 'Appels à Claude par jour',
    });
    const error = h('p.form-error', { role: 'alert' });
    return h(
      'form.sheet-body',
      {
        onsubmit: async (e: Event) => {
          e.preventDefault();
          try {
            overview = await hubApi.update(family.slug, { dailyLimit: Number(input.value) });
            close();
            actions.rerender();
          } catch (err) {
            error.textContent = err instanceof ApiError ? err.message : 'Plafond non enregistré.';
          }
        },
      },
      h(
        'p.sheet-lead',
        'Nombre d’appels à Claude par jour pour cette famille : un conseil ou un module de soutien compte pour un appel. À 0, plus rien n’est généré.',
      ),
      input,
      error,
      h(
        'div.sheet-actions',
        h('button.button', { type: 'button', onclick: close }, 'Annuler'),
        h('button.button.button-primary', { type: 'submit' }, 'Enregistrer'),
      ),
    );
  });
}

function familyRow(family: FamilyView, actions: SettingsActions): HTMLElement {
  const link = `${location.origin}/f/${family.slug}/`;
  return h(
    `li.family-row${family.disabled ? '.is-done' : ''}`,
    h(
      'p.report-meta',
      h('b', family.name),
      ` · créée le ${dayText(family.createdAt)} · ${family.usedToday}/${family.dailyLimit} appels aujourd’hui`,
      family.disabled && ' · suspendue',
    ),
    h('p.invite-link', link),
    h(
      'div.row-actions',
      h('button.link-button', { type: 'button', onclick: () => limitSheet(family, actions) }, 'Plafond'),
      h(
        'button.link-button',
        {
          type: 'button',
          onclick: () =>
            void hubApi
              .update(family.slug, { disabled: !family.disabled })
              .then((next) => (overview = next))
              .catch((e) => actions.toast(e instanceof ApiError ? e.message : 'Action impossible.'))
              .finally(actions.rerender),
        },
        family.disabled ? 'Rétablir' : 'Suspendre',
      ),
    ),
  );
}

/** Bloc de l'écran Moi de l'administrateur de la plateforme. */
export function hubBlock(actions: SettingsActions): HTMLElement {
  if (!overview && !loading && !failure && state.session?.hub) {
    loading = true;
    hubApi
      .families()
      .then((value) => (overview = value))
      .catch((e) => (failure = e instanceof ApiError ? e.message : 'Familles indisponibles.'))
      .finally(() => {
        loading = false;
        actions.rerender();
      });
  }
  const families = overview?.families ?? [];
  const waiting = overview?.invites.length ?? 0;
  return h(
    'section.block',
    sectionHead(
      'Familles hébergées',
      h('button.link-button', { type: 'button', onclick: () => inviteSheet(actions) }, 'Inviter'),
    ),
    failure && h('p.inline-error', failure),
    overview &&
      families.length === 0 &&
      h('p.hint', 'Aucune autre famille pour l’instant. Invite-en une avec le bouton ci-dessus.'),
    families.length > 0 &&
      h(
        'ul.report-list',
        families.map((f) => familyRow(f, actions)),
      ),
    waiting > 0 && h('p.hint', `${waiting} invitation${waiting > 1 ? 's' : ''} en attente.`),
  );
}

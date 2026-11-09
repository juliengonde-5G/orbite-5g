/**
 * Onglet « Moi » : préférences personnelles et, pour le parent administrateur,
 * la connexion ÉcoleDirecte et la gestion des profils de la famille.
 */
import { api, ApiError } from './api.ts';
import { clear, h, icon, tap } from './dom.ts';
import { initial, sinceText } from './format.ts';
import { state } from './state.ts';
import { sky } from './views.ts';
import type { AuthResult, ClaudeKeyStatus, ColorKey, MemberView, Prefs } from '../shared/types.ts';

export interface SettingsActions {
  rerender(): void;
  /** Retour à l'écran d'accueil. */
  back(): void;
  reloadSession(): Promise<void>;
  reloadData(): void;
  logout(): void;
  toast(message: string): void;
}

const COLORS: { key: ColorKey; label: string }[] = [
  { key: 'comete', label: 'Comète' },
  { key: 'soleil', label: 'Soleil' },
  { key: 'lagon', label: 'Lagon' },
  { key: 'corail', label: 'Corail' },
  { key: 'menthe', label: 'Menthe' },
  { key: 'prune', label: 'Prune' },
];

function segmented<T extends string>(
  label: string,
  value: T,
  options: [T, string][],
  onChange: (v: T) => void,
): HTMLElement {
  return h(
    'div.field',
    h('span.field-label', label),
    h(
      'div.segmented',
      { role: 'radiogroup', 'aria-label': label },
      options.map(([v, text]) =>
        h(
          `button${v === value ? '.is-active' : ''}`,
          { type: 'button', role: 'radio', 'aria-checked': String(v === value), onclick: () => onChange(v) },
          text,
        ),
      ),
    ),
  );
}

function colorPicker(value: ColorKey, onChange: (c: ColorKey) => void): HTMLElement {
  return h(
    'div.field',
    h('span.field-label', 'Couleur'),
    h(
      'div.swatches',
      { role: 'radiogroup', 'aria-label': 'Couleur' },
      COLORS.map((c) =>
        h(
          `button.swatch${c.key === value ? '.is-active' : ''}`,
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(c.key === value),
            'aria-label': c.label,
            style: { '--accent': `var(--c-${c.key})` },
            onclick: () => onChange(c.key),
          },
          c.key === value && icon('check', 16),
        ),
      ),
    ),
  );
}

function appendAll(el: HTMLElement, ...nodes: (Node | string | false | null | undefined)[]): void {
  for (const n of nodes) if (n) el.append(n);
}

/** Feuille modale du bas de l'écran (élément `<dialog>`). */
export function sheet(title: string, build: (close: () => void) => HTMLElement): void {
  const dialog = h('dialog.sheet', { 'aria-label': title }) as HTMLDialogElement;
  const close = () => {
    dialog.close();
    dialog.remove();
  };
  dialog.append(
    h(
      'div.sheet-inner',
      h(
        'header.sheet-head',
        h('h2', title),
        h('button.icon-button', { type: 'button', 'aria-label': 'Fermer', onclick: close }, icon('close')),
      ),
      build(close),
    ),
  );
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) close();
  });
  document.body.append(dialog);
  dialog.showModal();
}

function confirmSheet(title: string, text: string, action: string, run: () => Promise<void>): void {
  sheet(title, (close) =>
    h(
      'div.sheet-body',
      h('p', text),
      h(
        'div.sheet-actions',
        h('button.button', { type: 'button', onclick: close }, 'Annuler'),
        h(
          'button.button.button-danger',
          {
            type: 'button',
            onclick: async () => {
              await run();
              close();
            },
          },
          action,
        ),
      ),
    ),
  );
}

/* ---------- ÉcoleDirecte ---------- */

function edConnectSheet(actions: SettingsActions): void {
  sheet('Connecter ÉcoleDirecte', (close) => {
    const body = h('div.sheet-body');
    const error = h('p.form-error', { role: 'alert' });
    const run = async (task: () => Promise<AuthResult>) => {
      error.textContent = '';
      body.classList.add('is-busy');
      try {
        const result = await task();
        if (result.state === 'authenticated') {
          close();
          actions.toast('ÉcoleDirecte est connecté.');
          await actions.reloadSession();
          actions.reloadData();
        } else if (result.state === 'question') question(result.question, result.choices);
        else totp();
      } catch (e) {
        error.textContent = e instanceof ApiError ? e.message : 'Connexion impossible.';
      } finally {
        body.classList.remove('is-busy');
      }
    };
    const question = (text: string, choices: string[]) => {
      clear(body);
      body.append(
        h('p.sheet-lead', 'ÉcoleDirecte vérifie que c’est bien toi :'),
        h('p.question', text),
        h(
          'div.choices',
          choices.map((c, i) =>
            h(
              'button.button.choice',
              { type: 'button', onclick: () => void run(() => api.admin.verify({ choice: i })) },
              c,
            ),
          ),
        ),
        error,
      );
    };
    const totp = () => {
      clear(body);
      const code = h('input.text-input', {
        inputmode: 'numeric',
        autocomplete: 'one-time-code',
        maxlength: 6,
        placeholder: '123456',
        'aria-label': 'Code à six chiffres',
      });
      body.append(
        h('p.sheet-lead', 'Entre le code à six chiffres de ton application d’authentification.'),
        h(
          'form',
          {
            onsubmit: (e: Event) => {
              e.preventDefault();
              void run(() => api.admin.verify({ code: code.value.trim() }));
            },
          },
          code,
          h('button.button.button-primary', { type: 'submit' }, 'Valider'),
        ),
        h(
          'p.hint',
          'Avec un code TOTP, la reconnexion automatique n’est pas possible : il faudra se reconnecter à chaque expiration.',
        ),
        error,
      );
    };
    const user = h('input.text-input', {
      autocomplete: 'username',
      placeholder: 'Identifiant ÉcoleDirecte',
      'aria-label': 'Identifiant ÉcoleDirecte',
      autocapitalize: 'none',
      spellcheck: 'false',
    });
    const pass = h('input.text-input', {
      type: 'password',
      autocomplete: 'current-password',
      placeholder: 'Mot de passe',
      'aria-label': 'Mot de passe ÉcoleDirecte',
    });
    const remember = h('input', { type: 'checkbox', checked: true });
    body.append(
      h(
        'form.stack',
        {
          onsubmit: (e: Event) => {
            e.preventDefault();
            void run(() => api.admin.connect(user.value, pass.value, remember.checked));
          },
        },
        h(
          'p.sheet-lead',
          'Le compte parent donne accès aux notes et devoirs des trois enfants. Il n’est jamais montré aux autres membres.',
        ),
        user,
        pass,
        h(
          'label.toggle',
          remember,
          h(
            'span',
            h('b', 'Reconnexion automatique'),
            h('small', 'Identifiants gardés chiffrés sur le NAS, pour que l’appli fonctionne sans toi.'),
          ),
        ),
        h('button.button.button-primary', { type: 'submit' }, 'Se connecter'),
        error,
      ),
    );
    setTimeout(() => user.focus(), 60);
    return body;
  });
}

function edCard(actions: SettingsActions): HTMLElement {
  const ed = state.session?.ed;
  const me = state.session?.me;
  if (!ed) return h('div');
  const labels: Record<string, string> = {
    connected: 'Connecté',
    pending: 'Vérification en cours',
    attention: 'Action requise',
    disconnected: 'Non connecté',
  };
  return h(
    'section.block',
    h('header.section-head', h('h2', 'ÉcoleDirecte')),
    h(
      `div.ed-card.link-${ed.link}`,
      h('p.ed-state', h('span.dot'), labels[ed.link] ?? ed.link),
      ed.account && h('p.ed-line', `Compte ${ed.account}`),
      ed.link === 'connected' && h('p.ed-line', `Synchronisé ${sinceText(ed.lastSync)}`),
      ed.link === 'connected' &&
        h('p.ed-line', ed.autoReconnect ? 'Reconnexion automatique activée' : 'Reconnexion manuelle'),
      ed.message && h('p.ed-line.ed-message', ed.message),
      me?.admin
        ? h(
            'div.row-actions',
            h(
              'button.button.button-primary',
              { type: 'button', onclick: () => edConnectSheet(actions) },
              ed.link === 'connected' ? 'Changer de compte' : 'Connecter',
            ),
            ed.link !== 'disconnected' &&
              h(
                'button.button',
                {
                  type: 'button',
                  onclick: () =>
                    confirmSheet(
                      'Déconnecter ÉcoleDirecte ?',
                      'Les identifiants gardés sur le NAS seront effacés. Personne ne verra plus les données jusqu’à la prochaine connexion.',
                      'Déconnecter',
                      async () => {
                        await api.admin.disconnect();
                        await actions.reloadSession();
                        actions.reloadData();
                      },
                    ),
                },
                'Déconnecter',
              ),
          )
        : h('p.hint', 'Seul le parent administrateur gère la connexion.'),
    ),
  );
}

/* ---------- Clé API Claude ---------- */

let claudeStatus: ClaudeKeyStatus | null = null;
let claudeLoading = false;

function claudeKeySheet(actions: SettingsActions, replacing: boolean): void {
  sheet(replacing ? 'Remplacer la clé Claude' : 'Ajouter une clé Claude', (close) => {
    const input = h('input.text-input', {
      type: 'password',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: 'sk-ant-…',
      'aria-label': 'Clé API Anthropic',
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
            claudeStatus = await api.admin.setClaudeKey(input.value);
            close();
            actions.toast(
              claudeStatus.check === 'ok'
                ? 'Clé vérifiée et enregistrée.'
                : 'Clé enregistrée ; Anthropic n’a pas pu être joint pour la vérifier.',
            );
            await actions.reloadSession();
            actions.rerender();
          } catch (err) {
            error.textContent = err instanceof ApiError ? err.message : 'Clé non enregistrée.';
          } finally {
            body.classList.remove('is-busy');
          }
        },
      },
      h(
        'p.sheet-lead',
        'Colle la clé API créée sur console.anthropic.com (rubrique API Keys). Orbite la vérifie auprès d’Anthropic avant de l’enregistrer.',
      ),
      input,
      error,
      h(
        'p.hint',
        'Elle reste chiffrée sur le NAS et n’est jamais réaffichée. Elle sert aux conseils du jour et, bientôt, au soutien scolaire ; seules des données sans nom ni identité sont envoyées.',
      ),
      h(
        'div.sheet-actions',
        h('button.button', { type: 'button', onclick: close }, 'Annuler'),
        h('button.button.button-primary', { type: 'submit' }, 'Vérifier et enregistrer'),
      ),
    );
    queueMicrotask(() => input.focus());
    return body;
  });
}

/** Réglage de la clé API Claude (parent administrateur). */
function claudeCard(actions: SettingsActions): HTMLElement {
  if (!claudeStatus && !claudeLoading) {
    claudeLoading = true;
    api.admin
      .claude()
      .then((s) => {
        claudeStatus = s;
        actions.rerender();
      })
      .catch(() => undefined)
      .finally(() => {
        claudeLoading = false;
      });
  }
  const s = claudeStatus;
  const app = s?.source === 'app';
  return h(
    'section.block',
    h('header.section-head', h('h2', 'Claude (IA)')),
    h(
      `div.ed-card.link-${s?.configured ? 'connected' : 'disconnected'}`,
      h('p.ed-state', h('span.dot'), !s ? 'Chargement…' : s.configured ? 'Clé enregistrée' : 'Aucune clé'),
      s?.masked && h('p.ed-line', `Clé ${s.masked}`),
      s &&
        h(
          'p.ed-line',
          app
            ? `Saisie dans Orbite ${s.updatedAt ? sinceText(s.updatedAt) : ''}`.trim()
            : s.source === 'env'
              ? 'Définie dans le projet Container Manager (ANTHROPIC_API_KEY)'
              : 'Conseils du jour et soutien scolaire désactivés.',
        ),
      app && s?.check === 'unreachable' && h('p.ed-line.ed-message', 'Pas encore vérifiée auprès d’Anthropic.'),
      h(
        'div.row-actions',
        h(
          'button.button.button-primary',
          { type: 'button', disabled: !s, onclick: () => claudeKeySheet(actions, !!s?.configured) },
          s?.configured ? 'Remplacer la clé' : 'Ajouter une clé',
        ),
        app &&
          h(
            'button.button',
            {
              type: 'button',
              onclick: () =>
                confirmSheet('Retirer la clé Claude ?', envNote(s), 'Retirer', async () => {
                  claudeStatus = await api.admin.removeClaudeKey();
                  await actions.reloadSession();
                  actions.rerender();
                }),
            },
            'Retirer',
          ),
      ),
    ),
  );
}

function envNote(s: ClaudeKeyStatus | null): string {
  return s?.source === 'app'
    ? 'La clé saisie dans Orbite sera effacée du NAS. Si une clé est définie dans le projet Container Manager, elle reprendra le relais ; sinon les fonctions IA seront désactivées.'
    : 'Les fonctions IA seront désactivées.';
}

/* ---------- Profils de la famille ---------- */

function memberSheet(m: MemberView, actions: SettingsActions, refresh: () => void): void {
  sheet(m.name, (close) => {
    const body = h('div.sheet-body');
    const students = state.session?.ed?.students ?? [];
    const codeBox = h('div.code-box');
    const draw = () => {
      clear(body);
      appendAll(
        body,
        h(
          'section.sheet-section',
          h('h3', m.hasPin ? 'Code oublié ou nouveau téléphone' : 'Activer le profil'),
          h(
            'p.hint',
            m.hasPin
              ? 'Un nouveau code d’activation permet de choisir un autre PIN. Les anciens appareils seront déconnectés.'
              : `Donne ce code à ${m.name} : il l’entre dans Orbite et choisit son PIN.`,
          ),
          codeBox,
          h(
            'button.button.button-primary',
            {
              type: 'button',
              onclick: async () => {
                try {
                  const { code } = await api.admin.code(m.id);
                  tap(20);
                  clear(codeBox);
                  codeBox.append(
                    h('p.code', code),
                    h('p.hint', 'Valable 72 heures, une seule fois.'),
                    h(
                      'div.row-actions',
                      h(
                        'button.button.button-small',
                        {
                          type: 'button',
                          onclick: () =>
                            void navigator.clipboard?.writeText(code).then(() => actions.toast('Code copié.')),
                        },
                        icon('copy', 16),
                        'Copier',
                      ),
                      'share' in navigator &&
                        h(
                          'button.button.button-small',
                          {
                            type: 'button',
                            onclick: () =>
                              void navigator
                                .share({
                                  title: 'Orbite',
                                  text: `Ton code d’activation Orbite : ${code} (valable 72 h). Ouvre ${location.origin} et choisis ton profil.`,
                                })
                                .catch(() => undefined),
                          },
                          icon('share', 16),
                          'Envoyer',
                        ),
                    ),
                  );
                  refresh();
                } catch (e) {
                  actions.toast(e instanceof ApiError ? e.message : 'Impossible de créer le code.');
                }
              },
            },
            icon('key', 18),
            'Créer un code d’activation',
          ),
        ),
        m.role === 'child' &&
          h(
            'section.sheet-section',
            h('h3', 'Élève ÉcoleDirecte'),
            students.length
              ? h(
                  'label.select.select-wide',
                  h(
                    'select',
                    {
                      'aria-label': 'Élève rattaché',
                      onchange: async (e: Event) => {
                        const v = (e.target as HTMLSelectElement).value;
                        await api.admin.update(m.id, { studentId: v || null });
                        actions.toast('Rattachement enregistré.');
                        refresh();
                        actions.reloadData();
                      },
                    },
                    h('option', { value: '', selected: !m.studentId }, 'Aucun'),
                    students.map((s) =>
                      h('option', { value: s.id, selected: s.id === m.studentId }, `${s.name} (${s.className})`),
                    ),
                  ),
                )
              : h('p.hint', 'Connecte d’abord ÉcoleDirecte pour rattacher l’élève.'),
          ),
        h(
          'section.sheet-section',
          colorPicker(m.color, (color) => {
            void api.admin.update(m.id, { color }).then((updated) => {
              Object.assign(m, updated);
              draw();
              refresh();
            });
          }),
        ),
        m.role === 'parent' &&
          h(
            'label.toggle',
            h('input', {
              type: 'checkbox',
              checked: m.admin,
              onchange: async (e: Event) => {
                const el = e.target as HTMLInputElement;
                try {
                  const updated = await api.admin.update(m.id, { admin: el.checked });
                  Object.assign(m, updated);
                  refresh();
                } catch (err) {
                  el.checked = !el.checked;
                  actions.toast(err instanceof ApiError ? err.message : 'Modification impossible.');
                }
              },
            }),
            h('span', h('b', 'Administrateur'), h('small', 'Gère ÉcoleDirecte et les profils.')),
          ),
        h(
          'div.sheet-actions.sheet-actions-stack',
          m.hasPin &&
            h(
              'button.button',
              {
                type: 'button',
                onclick: async () => {
                  await api.admin.signout(m.id);
                  actions.toast(`${m.name} est déconnecté de tous ses appareils.`);
                },
              },
              icon('logout', 18),
              'Déconnecter ses appareils',
            ),
          m.id !== state.session?.me?.id &&
            h(
              'button.button.button-danger-ghost',
              {
                type: 'button',
                onclick: () =>
                  confirmSheet(
                    `Supprimer ${m.name} ?`,
                    'Le profil et ses appareils connectés seront supprimés. Les données ÉcoleDirecte ne changent pas.',
                    'Supprimer',
                    async () => {
                      await api.admin.remove(m.id);
                      close();
                      refresh();
                    },
                  ),
              },
              'Supprimer le profil',
            ),
        ),
      );
    };
    draw();
    return body;
  });
}

function addMemberSheet(refresh: () => void): void {
  sheet('Ajouter un profil', (close) => {
    const name = h('input.text-input', { placeholder: 'Prénom', 'aria-label': 'Prénom', autocomplete: 'off' });
    const grade = h('input.text-input', { placeholder: 'Classe (facultatif)', 'aria-label': 'Classe' });
    let role: 'child' | 'parent' = 'child';
    const roleField = () =>
      segmented(
        'Rôle',
        role,
        [
          ['child', 'Enfant'],
          ['parent', 'Parent'],
        ],
        (v) => {
          role = v;
          roleSlot.replaceChildren(roleField());
        },
      );
    const roleSlot = h('div', roleField());
    const error = h('p.form-error', { role: 'alert' });
    return h(
      'form.sheet-body.stack',
      {
        onsubmit: async (e: Event) => {
          e.preventDefault();
          try {
            await api.admin.add(name.value, role, grade.value);
            close();
            refresh();
          } catch (err) {
            error.textContent = err instanceof ApiError ? err.message : 'Ajout impossible.';
          }
        },
      },
      name,
      roleSlot,
      grade,
      h('button.button.button-primary', { type: 'submit' }, 'Ajouter'),
      error,
    );
  });
}

function familyBlock(actions: SettingsActions): HTMLElement {
  const list = h('ul.member-list');
  const refresh = () => {
    void api.admin
      .members()
      .then(({ members, ed }) => {
        state.members = members;
        if (state.session) state.session.ed = ed;
        paint();
      })
      .catch(() => undefined);
  };
  const paint = () => {
    clear(list);
    for (const m of state.members)
      list.append(
        h(
          'li',
          h(
            'button.member',
            {
              type: 'button',
              style: { '--accent': `var(--c-${m.color})` },
              onclick: () => memberSheet(m, actions, refresh),
            },
            h('span.avatar.avatar-sm', initial(m.name)),
            h(
              'span.member-text',
              h('b', m.name),
              h(
                'small',
                [m.role === 'parent' ? (m.admin ? 'Parent administrateur' : 'Parent') : 'Enfant', m.grade]
                  .filter(Boolean)
                  .join(', '),
              ),
            ),
            h(
              `span.chip${m.hasPin ? '' : '.chip-warn'}`,
              m.hasPin ? 'Actif' : m.activationPending ? 'Code envoyé' : 'À activer',
            ),
          ),
        ),
      );
  };
  paint();
  refresh();
  return h(
    'section.block',
    h(
      'header.section-head',
      h('h2', 'Famille'),
      h('button.link-button', { type: 'button', onclick: () => addMemberSheet(refresh) }, icon('plus', 16), 'Ajouter'),
    ),
    list,
  );
}

/* ---------- Écran ---------- */

function installHint(): HTMLElement | null {
  const standalone =
    matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone;
  if (standalone) return null;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  return h(
    'section.block',
    h('header.section-head', h('h2', 'Sur l’écran d’accueil')),
    h(
      'p.install',
      ios
        ? [
            'Dans Safari, touche ',
            icon('share', 16),
            ' Partager puis « Sur l’écran d’accueil ». Orbite s’ouvrira comme une appli.',
          ]
        : 'Dans le menu du navigateur, choisis « Installer l’application » ou « Ajouter à l’écran d’accueil ».',
    ),
  );
}

export function meView(actions: SettingsActions): HTMLElement {
  const me = state.session?.me;
  if (!me) return h('div');
  const setPrefs = async (prefs: Partial<Prefs> & { color?: ColorKey }) => {
    try {
      const updated = await api.prefs(prefs);
      if (state.session) state.session.me = updated;
      actions.rerender();
    } catch (e) {
      actions.toast(e instanceof ApiError ? e.message : 'Préférence non enregistrée.');
    }
  };
  return h(
    'div.screen.me',
    sky({
      title: me.name,
      subtitle:
        me.role === 'parent'
          ? me.admin
            ? 'Parent administrateur'
            : 'Parent'
          : [me.grade, 'Élève'].filter(Boolean).join(', '),
      back: () => actions.back(),
      actions: [h('span.avatar.avatar-md.sky-avatar', initial(me.name))],
    }),
    h(
      'section.block.prefs',
      h('header.section-head', h('h2', 'Affichage')),
      colorPicker(me.color, (color) => void setPrefs({ color })),
      segmented(
        'Thème',
        me.prefs.theme,
        [
          ['auto', 'Auto'],
          ['light', 'Clair'],
          ['dark', 'Sombre'],
        ],
        (theme) => void setPrefs({ theme }),
      ),
      segmented(
        'Lecture',
        me.prefs.reading,
        [
          ['standard', 'Standard'],
          ['dyslexia', 'OpenDyslexic'],
          ['large', 'Grand'],
        ],
        (reading) => void setPrefs({ reading }),
      ),
    ),
    me.role === 'parent' && edCard(actions),
    me.role === 'parent' && me.admin && claudeCard(actions),
    me.role === 'parent' && me.admin && familyBlock(actions),
    installHint(),
    h(
      'section.block',
      h(
        'button.button.button-wide',
        { type: 'button', onclick: () => actions.logout() },
        icon('logout', 18),
        'Verrouiller et changer de profil',
      ),
      h(
        'p.footnote',
        `Orbite ${state.session?.version ?? ''}, d’après Orbite de Thomas Fauré (licence MIT). Données lues sur ÉcoleDirecte, jamais modifiées.`,
      ),
    ),
  );
}

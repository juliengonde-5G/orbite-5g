/**
 * Assistant d'installation (parent administrateur) : un pas à pas pour mettre
 * Orbite en route dans la famille — connecter ÉcoleDirecte, ajouter les profils,
 * les activer sur les téléphones, puis réglages facultatifs. L'état de chaque
 * étape se lit dans l'application ; rien n'est à cocher à la main.
 */
import { h, icon } from './dom.ts';
import { state } from './state.ts';
import { addMemberSheet, edConnectSheet, memberSheet, type SettingsActions } from './settings.ts';
import { api } from './api.ts';
import { sky } from './views.ts';

const DISMISSED = 'orbite.installation-faite';

const dismissed = (): boolean => {
  try {
    return localStorage.getItem(DISMISSED) === '1';
  } catch {
    return false;
  }
};

interface Progress {
  ed: boolean;
  children: number;
  activated: number;
  required: number;
  total: number;
}

function progress(): Progress {
  const kids = state.members.filter((m) => m.role === 'child');
  const ed = state.session?.ed?.link === 'connected';
  const activated = kids.filter((m) => m.hasPin).length;
  const done = [ed, kids.length > 0, kids.length > 0 && activated === kids.length].filter(Boolean).length;
  return { ed, children: kids.length, activated, required: done, total: 3 };
}

const standalone = (): boolean =>
  matchMedia('(display-mode: standalone)').matches || !!(navigator as Navigator & { standalone?: boolean }).standalone;

function step(
  n: number,
  title: string,
  done: boolean,
  body: (Node | string | false | null)[],
  optional = false,
): HTMLElement {
  return h(
    `section.block.setup-step${done ? '.is-done' : ''}`,
    h(
      'header.section-head',
      h('h2', h('span.setup-num', done ? icon('check', 16) : String(n)), title),
      optional && h('span.chip', 'Facultatif'),
    ),
    ...body,
  );
}

/** Carte d'accueil du parent administrateur tant que l'installation n'est pas terminée. */
export function setupCard(actions: Pick<SettingsActions, 'go'>): HTMLElement | null {
  if (state.session?.me?.admin !== true || dismissed()) return null;
  const p = progress();
  if (p.required === p.total) return null;
  return h(
    'section.block.news-banner',
    h(
      'div.news-banner-text',
      h('b', 'Termine l’installation d’Orbite'),
      h('span', `Étapes faites : ${p.required} sur ${p.total}`),
    ),
    h(
      'div.row-actions',
      h('button.button.button-primary', { type: 'button', onclick: () => actions.go('setup') }, 'Ouvrir l’assistant'),
    ),
  );
}

export function setupView(actions: SettingsActions): HTMLElement {
  const me = state.session?.me;
  const refresh = () => {
    void api.admin
      .members()
      .then(({ members, ed }) => {
        state.members = members;
        if (state.session) state.session.ed = ed;
      })
      .catch(() => undefined)
      .finally(actions.rerender);
  };
  const p = progress();
  const kids = state.members.filter((m) => m.role === 'child');
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const body = h(
    'div.flow',
    h(
      'section.block',
      h(
        'p.train-lead',
        `Étapes faites : ${p.required} sur ${p.total}. Chacune se coche toute seule quand elle est faite.`,
      ),
    ),
    step(1, 'Connecter ÉcoleDirecte', p.ed, [
      h(
        'p.train-lead',
        'Saisis les identifiants du compte parent ÉcoleDirecte. Ils restent chiffrés sur le serveur ; Orbite ne fait que lire. ÉcoleDirecte peut demander une question de sécurité : réponds-y dans la fenêtre qui s’ouvre.',
      ),
      !p.ed &&
        h(
          'div.row-actions',
          h(
            'button.button.button-primary',
            { type: 'button', onclick: () => edConnectSheet(actions) },
            'Connecter ÉcoleDirecte',
          ),
        ),
    ]),
    step(2, 'Ajouter les enfants', p.children > 0, [
      h(
        'p.train-lead',
        'Crée un profil par enfant (prénom, classe) puis relie-le à son compte ÉcoleDirecte. Les autres parents ont aussi leur profil.',
      ),
      h(
        'div.row-actions',
        h(
          'button.button.button-primary',
          { type: 'button', onclick: () => addMemberSheet(refresh) },
          'Ajouter un profil',
        ),
      ),
      p.ed ? null : h('p.hint', 'Connecte d’abord ÉcoleDirecte pour pouvoir relier chaque enfant à son compte.'),
    ]),
    step(3, 'Activer les profils sur les téléphones', p.children > 0 && p.activated === p.children, [
      h(
        'p.train-lead',
        'Pour chaque profil, génère un code d’activation. La personne l’entre sur son téléphone, puis choisit son PIN.',
      ),
      kids.length > 0
        ? h(
            'ul.member-list',
            state.members.map((m) =>
              h(
                'li',
                h(
                  'button.member',
                  { type: 'button', onclick: () => memberSheet(m, actions, refresh) },
                  h('span.avatar.avatar-sm', m.name.slice(0, 1).toUpperCase()),
                  h('span.member-text', h('b', m.name)),
                  h(`span.chip${m.hasPin ? '' : '.chip-warn'}`, m.hasPin ? 'Actif' : 'À activer'),
                ),
              ),
            ),
          )
        : h('p.hint', 'Ajoute d’abord un profil à l’étape 2.'),
    ]),
    step(
      4,
      'Mettre Orbite sur l’écran d’accueil',
      standalone(),
      [
        h(
          'p.train-lead',
          ios
            ? 'Sur iPhone, ouvre ton lien dans Safari, touche Partager puis « Sur l’écran d’accueil ». C’est indispensable pour recevoir les notifications (iOS 16.4 ou plus).'
            : 'Dans le menu du navigateur, choisis « Installer l’application » ou « Ajouter à l’écran d’accueil ».',
        ),
        h('p.hint', 'À refaire sur le téléphone de chaque personne : le lien est le même pour toute la famille.'),
      ],
      true,
    ),
    step(
      5,
      'Les notifications',
      false,
      [
        h(
          'p.train-lead',
          'Nouvelle note (sans la valeur), message du collège, rappel du cartable le soir. Chaque profil choisit ce qu’il reçoit.',
        ),
        h(
          'div.row-actions',
          h('button.button', { type: 'button', onclick: () => actions.go('me') }, 'Régler dans Moi'),
        ),
      ],
      true,
    ),
    step(
      6,
      'Le soutien scolaire',
      false,
      [
        h(
          'p.train-lead',
          'Un entraînement de dix minutes par jour en maths, français et anglais, d’après les compétences ÉcoleDirecte. Ouvre la page d’un enfant et touche « Activer le soutien ».',
        ),
      ],
      true,
    ),
    h(
      'section.block',
      h(
        'div.row-actions',
        h(
          'button.button.button-primary',
          {
            type: 'button',
            disabled: p.required < p.total,
            onclick: () => {
              try {
                localStorage.setItem(DISMISSED, '1');
              } catch {}
              actions.back();
            },
          },
          'Terminer l’installation',
        ),
        h('button.link-button', { type: 'button', onclick: () => actions.back() }, 'Plus tard'),
      ),
    ),
  );
  return h(
    'div.screen.narrow.setup',
    sky({ title: 'Installation', subtitle: me ? `Bienvenue, ${me.name}` : null, back: () => actions.back() }),
    body,
  );
}

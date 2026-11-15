/**
 * Page d'invitation : la famille invitée crée son espace Orbite en trois temps
 * (bienvenue, sa famille, son lien), puis poursuit avec l'assistant d'installation.
 *
 * L'invitation est un lien à usage unique créé par l'administrateur de la
 * plateforme. Le code d'installation de la famille n'est jamais montré : cette page
 * le présente elle-même au serveur pour que le parent choisisse son PIN.
 */
import { ApiError, hubApi } from './api.ts';
import { clear, h } from './dom.ts';

const message = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

function shell(...content: (Node | string | false | null)[]): HTMLElement {
  return h(
    'div.shell',
    h(
      'main.view',
      h(
        'div.screen.narrow.invite',
        h('header.top.is-big', h('div.sky-bar', h('div.top-text', h('h1.title', 'Bienvenue dans Orbite')))),
        h('div.flow', ...content),
      ),
    ),
  );
}

function welcome(root: HTMLElement, token: string, label: string): HTMLElement {
  return shell(
    h(
      'section.block',
      h('p.train-lead', `Invitation : ${label}`),
      h(
        'p.train-lead',
        'Orbite réunit les notes, les devoirs et les progrès des enfants, lus sur ÉcoleDirecte. L’installation prend une dizaine de minutes.',
      ),
      h('h2.setup-subtitle', 'Ce qu’il te faut'),
      h(
        'ul.setup-list',
        h('li', 'Les identifiants du compte parent ÉcoleDirecte.'),
        h('li', 'Un téléphone pour ajouter Orbite à l’écran d’accueil.'),
        h('li', 'Un code PIN à six chiffres, que toi seul connaîtras.'),
      ),
      h('h2.setup-subtitle', 'Ta confidentialité'),
      h(
        'ul.setup-list',
        h('li', 'Les données de ta famille sont chiffrées et séparées de celles des autres familles.'),
        h('li', 'Orbite ne fait que lire ÉcoleDirecte : rien n’y est jamais modifié.'),
        h('li', 'Chaque enfant ne voit que ses propres résultats.'),
        h(
          'li',
          'Les exercices de soutien sont rédigés par Claude, qui ne reçoit que la matière, le niveau et la compétence.',
        ),
      ),
      h(
        'div.row-actions',
        h(
          'button.button.button-primary',
          { type: 'button', onclick: () => show(root, family(root, token)) },
          'Commencer',
        ),
      ),
    ),
  );
}

function family(root: HTMLElement, token: string): HTMLElement {
  const name = h('input.text-input', {
    type: 'text',
    autocomplete: 'off',
    maxlength: '40',
    placeholder: 'Famille Dupont',
    'aria-label': 'Nom de la famille',
  });
  const admin = h('input.text-input', {
    type: 'text',
    autocomplete: 'given-name',
    maxlength: '30',
    placeholder: 'Ton prénom',
    'aria-label': 'Ton prénom',
  });
  const pin = h('input.text-input', {
    type: 'password',
    inputmode: 'numeric',
    autocomplete: 'new-password',
    maxlength: '6',
    placeholder: 'PIN à six chiffres',
    'aria-label': 'PIN à six chiffres',
  });
  const again = h('input.text-input', {
    type: 'password',
    inputmode: 'numeric',
    autocomplete: 'new-password',
    maxlength: '6',
    placeholder: 'Répète le PIN',
    'aria-label': 'Répète le PIN',
  });
  const consent = h('input', { type: 'checkbox', id: 'consent' }) as HTMLInputElement;
  const error = h('p.form-error', { role: 'alert' });
  const fail = (text: string) => {
    error.textContent = text;
  };
  const form = h(
    'form.block.sheet-body',
    {
      onsubmit: async (e: Event) => {
        e.preventDefault();
        error.textContent = '';
        if (!/^\d{6}$/.test(pin.value)) return fail('Le PIN doit faire six chiffres.');
        if (pin.value !== again.value) return fail('Les deux PIN ne correspondent pas.');
        if (!consent.checked) return fail('Coche la case pour continuer.');
        form.classList.add('is-busy');
        try {
          const created = await hubApi.create(token, name.value, admin.value);
          await hubApi.setupParent(created.url, created.adminName, pin.value, created.setupCode);
          show(root, done(created.url, created.name));
        } catch (err) {
          error.textContent = message(err, 'Création impossible, réessaie.');
        } finally {
          form.classList.remove('is-busy');
        }
      },
    },
    h('h2.setup-subtitle', 'Ta famille'),
    name,
    admin,
    h('p.hint', 'Tu seras le parent administrateur : tu connectes ÉcoleDirecte et tu ajoutes les profils.'),
    pin,
    again,
    h(
      'label.consent',
      consent,
      h(
        'span',
        'Je suis parent ou responsable légal des enfants concernés et j’accepte que leurs données scolaires soient conservées, chiffrées, sur ce serveur.',
      ),
    ),
    error,
    h('div.row-actions', h('button.button.button-primary', { type: 'submit' }, 'Créer ma famille')),
  );
  queueMicrotask(() => name.focus());
  return shell(form);
}

function done(url: string, familyName: string): HTMLElement {
  const link = location.origin + url;
  const copied = h('span.hint');
  return shell(
    h(
      'section.block',
      h('h2.setup-subtitle', `${familyName} est créée`),
      h('p.train-lead', 'Voici le lien de ta famille. Garde-le : c’est la seule adresse où ouvrir Orbite.'),
      h('p.invite-link', link),
      h(
        'div.row-actions',
        h(
          'button.button',
          {
            type: 'button',
            onclick: () =>
              void navigator.clipboard
                ?.writeText(link)
                .then(() => (copied.textContent = 'Lien copié.'))
                .catch(() => (copied.textContent = 'Copie impossible : sélectionne le lien.')),
          },
          'Copier le lien',
        ),
        copied,
      ),
      h(
        'div.row-actions',
        h(
          'button.button.button-primary',
          { type: 'button', onclick: () => location.assign(`${url}#installation`) },
          'Continuer l’installation',
        ),
      ),
    ),
  );
}

function show(root: HTMLElement, view: HTMLElement): void {
  clear(root);
  root.append(view);
  window.scrollTo({ top: 0 });
}

/** Affiche la page d'invitation pour ce jeton, ou le motif du refus. */
export async function inviteView(root: HTMLElement, token: string): Promise<void> {
  try {
    const { label } = await hubApi.check(token);
    show(root, welcome(root, token, label));
  } catch (e) {
    show(
      root,
      shell(
        h(
          'section.block',
          h('p.inline-error', message(e, 'Invitation introuvable.')),
          h('p.hint', 'Demande à la personne qui t’a invité de t’envoyer un nouveau lien.'),
        ),
      ),
    );
  }
}

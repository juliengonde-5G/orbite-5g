/**
 * Écran de verrouillage : choix du profil puis code PIN à six chiffres.
 *
 * Cas particuliers :
 * - installation : le parent administrateur choisit son PIN (depuis la maison) ;
 * - profil pas encore activé : code d'activation donné par un parent, puis PIN ;
 * - appareil inconnu hors de la maison : les prénoms ne sont pas affichés, on
 *   tape son prénom.
 */
import { api, ApiError } from './api.ts';
import { clear, h, icon, tap } from './dom.ts';
import { initial } from './format.ts';
import type { SessionInfo } from '../shared/types.ts';

type Member = SessionInfo['members'][number];
type Who = { memberId?: string; name?: string };

interface LockContext {
  root: HTMLElement;
  session: SessionInfo;
  onUnlocked: (session: SessionInfo) => void;
}

function keypad(options: {
  title: string;
  hint?: string;
  error?: string;
  color?: string;
  onDone: (pin: string) => Promise<void>;
  onBack: () => void;
}): HTMLElement {
  let pin = '';
  let busy = false;
  const dots = h(
    'div.pin-dots',
    { 'aria-hidden': 'true' },
    [0, 1, 2, 3, 4, 5].map(() => h('span.pin-dot')),
  );
  const status = h(
    `p.pin-status${options.error ? '.is-error' : ''}`,
    { role: 'status' },
    options.error ?? options.hint ?? '',
  );
  const sr = h('span.sr-only', { 'aria-live': 'polite' });
  const paint = () => {
    for (const [i, d] of [...dots.children].entries()) d.classList.toggle('is-on', i < pin.length);
    sr.textContent = `${pin.length} chiffre${pin.length > 1 ? 's' : ''} sur 6`;
  };
  const press = async (key: string) => {
    if (busy) return;
    tap();
    if (key === 'del') pin = pin.slice(0, -1);
    else if (pin.length < 6) pin += key;
    paint();
    if (pin.length === 6) {
      busy = true;
      wrap.classList.add('is-busy');
      try {
        await options.onDone(pin);
      } catch (e) {
        status.textContent = e instanceof ApiError ? e.message : 'Erreur inattendue.';
        status.classList.add('is-error');
        wrap.classList.remove('shake');
        void wrap.offsetWidth;
        wrap.classList.add('shake');
        tap(40);
      } finally {
        pin = '';
        busy = false;
        wrap.classList.remove('is-busy');
        paint();
      }
    }
  };
  const key = (label: string, value: string, extra = '') =>
    h(
      `button.key${extra}`,
      { type: 'button', 'aria-label': value === 'del' ? 'Effacer' : label, onclick: () => void press(value) },
      label,
    );
  const wrap = h(
    'section.pin',
    { style: options.color ? { '--accent': `var(--c-${options.color})` } : {} },
    h(
      'button.icon-button.pin-back',
      { type: 'button', 'aria-label': 'Retour aux profils', onclick: options.onBack },
      icon('back'),
    ),
    h('h1.pin-title', options.title),
    dots,
    status,
    sr,
    h(
      'div.keys',
      ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => key(d, d)),
      h('span.key-spacer'),
      key('0', '0'),
      h(
        'button.key.key-del',
        { type: 'button', 'aria-label': 'Effacer', onclick: () => void press('del') },
        icon('erase', 26),
      ),
    ),
  );
  const onKey = (e: KeyboardEvent) => {
    if (!wrap.isConnected) return document.removeEventListener('keydown', onKey);
    if (/^\d$/.test(e.key)) void press(e.key);
    else if (e.key === 'Backspace') void press('del');
  };
  document.addEventListener('keydown', onKey);
  return wrap;
}

/** Saisie du nouveau PIN en deux temps (choix puis confirmation). */
function choosePin(
  ctx: LockContext,
  title: string,
  color: string | undefined,
  submit: (pin: string) => Promise<SessionInfo>,
  back: () => void,
): void {
  let first = '';
  const step = (again: boolean, error?: string) => {
    show(
      ctx,
      keypad({
        title: again ? 'Confirme ton code' : title,
        hint: again ? 'Tape-le une seconde fois.' : 'Six chiffres, évite ta date de naissance.',
        ...(error ? { error } : {}),
        ...(color ? { color } : {}),
        onBack: back,
        onDone: async (pin) => {
          if (!again) {
            first = pin;
            step(true);
            return;
          }
          if (pin !== first) {
            first = '';
            step(false, 'Les deux codes sont différents. Recommence.');
            return;
          }
          try {
            ctx.onUnlocked(await submit(pin));
          } catch (e) {
            first = '';
            step(false, e instanceof ApiError ? e.message : 'Erreur inattendue.');
          }
        },
      }),
    );
  };
  step(false);
}

function show(ctx: LockContext, content: HTMLElement): void {
  const screen = ctx.root.querySelector('.lock-body');
  if (screen) {
    clear(screen);
    screen.append(content);
  }
}

function activation(ctx: LockContext, who: Who, name: string, color: string | undefined): void {
  const input = h('input.code-input', {
    type: 'text',
    inputmode: 'text',
    autocomplete: 'one-time-code',
    autocapitalize: 'characters',
    spellcheck: 'false',
    maxlength: 9,
    placeholder: 'XXXX-XXXX',
    'aria-label': 'Code d’activation',
  });
  const error = h('p.form-error', { role: 'alert' });
  input.addEventListener('input', () => {
    const raw = input.value
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8);
    input.value = raw.length > 4 ? raw.slice(0, 4) + '-' + raw.slice(4) : raw;
  });
  const form = h(
    'form.activation',
    {
      style: color ? { '--accent': `var(--c-${color})` } : {},
      onsubmit: (e: Event) => {
        e.preventDefault();
        const code = input.value;
        if (code.replace('-', '').length !== 8) {
          error.textContent = 'Le code fait 8 caractères.';
          return;
        }
        choosePin(
          ctx,
          `Choisis ton code, ${name}`,
          color,
          (pin) => api.activate(who, code, pin),
          () => pick(ctx),
        );
      },
    },
    h(
      'button.icon-button.pin-back',
      { type: 'button', 'aria-label': 'Retour aux profils', onclick: () => pick(ctx) },
      icon('back'),
    ),
    h('h1.pin-title', `Bienvenue ${name}`),
    h('p.lock-text', 'Entre le code d’activation qu’un parent t’a donné.'),
    input,
    error,
    h('button.button.button-primary', { type: 'submit' }, 'Continuer'),
  );
  show(ctx, form);
  setTimeout(() => input.focus(), 50);
}

/** Installation hors de la maison : code affiché dans le journal du conteneur, puis PIN. */
function setupCode(ctx: LockContext, m: Member | null): void {
  const nameInput = m
    ? null
    : h('input.text-input', {
        type: 'text',
        autocomplete: 'given-name',
        placeholder: 'Ton prénom',
        'aria-label': 'Ton prénom',
      });
  const input = h('input.code-input', {
    type: 'text',
    autocomplete: 'off',
    autocapitalize: 'characters',
    spellcheck: 'false',
    maxlength: 9,
    placeholder: 'XXXX-XXXX',
    'aria-label': 'Code d’installation',
  });
  input.addEventListener('input', () => {
    const raw = input.value
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8);
    input.value = raw.length > 4 ? raw.slice(0, 4) + '-' + raw.slice(4) : raw;
  });
  const error = h('p.form-error', { role: 'alert' });
  show(
    ctx,
    h(
      'form.activation',
      {
        style: m ? { '--accent': `var(--c-${m.color})` } : {},
        onsubmit: (e: Event) => {
          e.preventDefault();
          const code = input.value;
          const name = m ? m.name : (nameInput?.value.trim() ?? '');
          if (!name) {
            error.textContent = 'Indique ton prénom.';
            return;
          }
          if (code.replace('-', '').length !== 8) {
            error.textContent = 'Le code fait 8 caractères.';
            return;
          }
          const who = m ? { memberId: m.id } : { name };
          choosePin(
            ctx,
            `Choisis ton code, ${name}`,
            m?.color,
            (pin) => api.setup(who, pin, code),
            () => pick(ctx),
          );
        },
      },
      h(
        'button.icon-button.pin-back',
        { type: 'button', 'aria-label': 'Retour aux profils', onclick: () => pick(ctx) },
        icon('back'),
      ),
      h('h1.pin-title', 'Installation'),
      h('p.lock-text', 'Entre le code d’installation affiché dans le journal du conteneur « orbite » sur le Synology.'),
      nameInput,
      input,
      error,
      h('button.button.button-primary', { type: 'submit' }, 'Continuer'),
    ),
  );
  setTimeout(() => input.focus(), 50);
}

function openMember(ctx: LockContext, m: Member): void {
  const who = { memberId: m.id };
  if (m.hasPin) {
    show(
      ctx,
      keypad({
        title: m.name,
        hint: m.lockedUntil ? 'Profil bloqué un moment après trop d’essais.' : 'Entre ton code',
        color: m.color,
        onBack: () => pick(ctx),
        onDone: async (pin) => ctx.onUnlocked(await api.login(who, pin)),
      }),
    );
  } else if (m.admin && ctx.session.setupNeeded) {
    if (!ctx.session.onLan) {
      setupCode(ctx, m);
      return;
    }
    choosePin(
      ctx,
      `Choisis ton code, ${m.name}`,
      m.color,
      (pin) => api.setup({ memberId: m.id }, pin),
      () => pick(ctx),
    );
  } else activation(ctx, who, m.name, m.color);
}

function byName(ctx: LockContext): void {
  const input = h('input.text-input', {
    type: 'text',
    autocomplete: 'given-name',
    placeholder: 'Ton prénom',
    'aria-label': 'Ton prénom',
  });
  const form = h(
    'form.activation',
    {
      onsubmit: (e: Event) => {
        e.preventDefault();
        const name = input.value.trim();
        if (!name) return;
        show(
          ctx,
          h(
            'section.choice',
            h('h1.pin-title', name),
            h(
              'button.button.button-primary',
              {
                type: 'button',
                onclick: () =>
                  show(
                    ctx,
                    keypad({
                      title: name,
                      hint: 'Entre ton code',
                      onBack: () => byName(ctx),
                      onDone: async (pin) => ctx.onUnlocked(await api.login({ name }, pin)),
                    }),
                  ),
              },
              'J’ai déjà mon code',
            ),
            h(
              'button.button',
              { type: 'button', onclick: () => activation(ctx, { name }, name, undefined) },
              'J’ai un code d’activation',
            ),
            h('button.link-button', { type: 'button', onclick: () => byName(ctx) }, 'Changer de prénom'),
          ),
        );
      },
    },
    h('h1.pin-title', 'Qui es-tu ?'),
    h('p.lock-text', 'Cet appareil n’a encore jamais ouvert Orbite.'),
    input,
    h('button.button.button-primary', { type: 'submit' }, 'Continuer'),
  );
  show(ctx, form);
  setTimeout(() => input.focus(), 50);
}

function pick(ctx: LockContext): void {
  const { members, setupNeeded } = ctx.session;
  if (!members.length) {
    if (ctx.session.setupNeeded) setupCode(ctx, null);
    else byName(ctx);
    return;
  }
  const ordered = [...members].sort((a, b) => Number(b.role === 'parent') - Number(a.role === 'parent'));
  show(
    ctx,
    h(
      'section.profiles',
      h('h1.lock-title', setupNeeded ? 'Bienvenue dans Orbite' : 'Qui est là ?'),
      setupNeeded && h('p.lock-text', 'Le parent administrateur commence par choisir son code.'),
      h(
        'ul.profile-grid',
        ordered.map((m) => {
          const disabled = setupNeeded && !m.admin;
          return h(
            'li',
            h(
              'button.profile',
              {
                type: 'button',
                disabled,
                style: { '--accent': `var(--c-${m.color})` },
                onclick: () => {
                  tap();
                  openMember(ctx, m);
                },
              },
              h('span.avatar.avatar-lg', initial(m.name)),
              h('span.profile-name', m.name),
              h(
                'span.profile-state',
                m.hasPin
                  ? ''
                  : m.admin && setupNeeded
                    ? 'À installer'
                    : m.activationPending
                      ? 'Code reçu ?'
                      : 'À activer',
              ),
            ),
          );
        }),
      ),
    ),
  );
}

export function renderLock(root: HTMLElement, session: SessionInfo, onUnlocked: (s: SessionInfo) => void): void {
  clear(root);
  document.documentElement.dataset.screen = 'lock';
  root.append(
    h(
      'main.lock',
      h(
        'header.lock-brand',
        h('img', { src: '/favicon.svg', alt: '', width: 40, height: 40 }),
        h('span.wordmark', 'Orbite'),
      ),
      h('div.lock-body'),
    ),
  );
  pick({ root, session, onUnlocked });
}

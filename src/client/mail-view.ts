/**
 * Messagerie de l'établissement, en lecture seule.
 *
 * Parents : boîte famille (compte parent) et boîte élève de chaque enfant ; un
 * message famille peut être partagé avec un ou plusieurs enfants. Élèves : leur
 * propre messagerie ÉcoleDirecte et ce que leurs parents leur ont partagé.
 */
import { h, icon, tap } from './dom.ts';
import { capitalize, clockText, initial, longDay, relativeDay } from './format.ts';
import { accent, childColor, emptyState, sectionHead, sky, skyButton, type Actions } from './views.ts';
import { state } from './state.ts';
import { parisDate } from '../shared/metrics.ts';
import type { Child, MailDetail, MailItem } from '../shared/types.ts';

/** Boîte affichée : celle choisie par un parent, sa propre messagerie pour un élève. */
export function mailScope(): string {
  const me = state.session?.me;
  if (me?.role === 'parent') return state.mailScope;
  return me?.studentId ?? '';
}

function senderInitial(from: string): string {
  const words = (from.split(' · ')[0] ?? from)
    .split(/\s+/)
    .filter((w) => w && !/^(m|mme|mlle|mr|dr)\.?$/i.test(w) && !/^[A-Z]\.$/i.test(w));
  return initial(words.at(-1) ?? from);
}

function when(date: string): string {
  if (!date) return '';
  const day = date.slice(0, 10);
  return day === parisDate(new Date()) ? clockText(date.slice(11, 16)) : relativeDay(day);
}

function mailRow(item: MailItem, actions: Actions, showShare = true): HTMLElement {
  const kids = (state.data?.children ?? []).filter((c) => item.sharedWith?.includes(c.id));
  const owner = item.childId ? state.data?.children.find((c) => c.id === item.childId) : null;
  return h(
    `li.mail${item.isNew ? '.is-new' : ''}`,
    h(
      'button.mail-row',
      {
        type: 'button',
        onclick: () => {
          tap();
          actions.openMessage(item.key);
        },
      },
      h(`span.mail-avatar.role-${item.fromRole}`, senderInitial(item.from)),
      h(
        'span.mail-main',
        h('span.mail-top', h('span.mail-from', item.from), h('span.mail-date', when(item.date))),
        h('span.mail-subject', item.isNew && h('span.mail-dot', { 'aria-label': 'Non lu' }), item.subject),
        (item.files.length > 0 ||
          (showShare && kids.length > 0) ||
          (item.box === 'family' && state.session?.me?.role === 'child') ||
          (showShare && owner)) &&
          h(
            'span.mail-meta',
            item.files.length > 0 &&
              h(
                'span.mail-clip',
                icon('clip', 14),
                item.files.length > 1 ? `${item.files.length} pièces jointes` : item.files[0]?.name,
              ),
            state.session?.me?.role === 'child' &&
              item.box === 'family' &&
              h('span.mail-tag', 'Partagé par tes parents'),
            showShare && kids.map((c) => h('span.mail-tag', { style: accent(c.id) }, `Partagé avec ${c.name}`)),
          ),
      ),
    ),
  );
}

/** Liste groupée : aujourd'hui, cette semaine, plus ancien. */
function groupedList(items: MailItem[], actions: Actions): HTMLElement {
  const today = parisDate(new Date());
  const age = (d: string) => (Date.parse(today + 'T12:00:00Z') - Date.parse(d.slice(0, 10) + 'T12:00:00Z')) / 86400000;
  const groups: [string, MailItem[]][] = [
    ['Aujourd’hui', items.filter((i) => i.date.slice(0, 10) === today)],
    ['Cette semaine', items.filter((i) => i.date.slice(0, 10) !== today && age(i.date) < 7)],
    ['Plus ancien', items.filter((i) => !i.date || age(i.date) >= 7)],
  ];
  return h(
    'div.days',
    groups
      .filter(([, list]) => list.length)
      .map(([label, list]) =>
        h(
          'section.block',
          sectionHead(label),
          h(
            'ul.mail-list',
            list.map((i) => mailRow(i, actions)),
          ),
        ),
      ),
  );
}

function scopeChips(actions: Actions): HTMLElement {
  const children = state.data?.children ?? [];
  const chip = (id: string, label: string, mark: HTMLElement | SVGElement) =>
    h(
      `button.switch${state.mailScope === id ? '.is-active' : ''}`,
      {
        type: 'button',
        style: id === 'family' ? null : accent(id),
        'aria-pressed': String(state.mailScope === id),
        onclick: () => {
          tap();
          state.mailScope = id;
          actions.rerender();
        },
      },
      mark,
      label,
    );
  return h(
    'nav.switcher',
    { 'aria-label': 'Boîte de réception' },
    chip('family', 'Famille', h('span.avatar.avatar-xs.avatar-family', icon('family', 14))),
    children.map((c) => chip(c.id, c.name, h('span.avatar.avatar-xs', initial(c.name)))),
  );
}

export function messagesView(actions: Actions): HTMLElement {
  const parent = state.session?.me?.role === 'parent';
  const scope = mailScope();
  const entry = state.mail.get(scope);
  if (!entry && scope) actions.loadMail(scope);
  const list = entry?.value;
  const kid = scope !== 'family' ? state.data?.children.find((c) => c.id === scope) : null;
  return h(
    'div.screen.narrow.messages',
    kid && parent ? { style: accent(kid.id) } : null,
    sky({
      title: 'Messages',
      subtitle: parent
        ? scope === 'family'
          ? 'Messagerie famille du collège'
          : `Messagerie élève de ${kid?.name ?? ''}`
        : 'Reçus du collège et de tes profs',
      actions: [skyButton('Relire les messages', 'refresh', () => actions.loadMail(scope, true), !!entry?.loading)],
      extra: [parent && scopeChips(actions)],
    }),
    entry?.error &&
      h(
        'div.inline-error',
        entry.error,
        h('button.link-button', { type: 'button', onclick: () => actions.loadMail(scope, true) }, 'Réessayer'),
      ),
    list?.unavailable && h('p.inline-note', list.unavailable),
    !list &&
      !entry?.error &&
      h(
        'div.bag-loading',
        [0, 1, 2, 3].map(() => h('div.skeleton')),
      ),
    list &&
      (list.items.length
        ? groupedList(list.items, actions)
        : !list.unavailable &&
          emptyState(
            'Aucun message',
            parent
              ? 'Rien reçu cette année dans cette boîte.'
              : 'Les messages de tes profs et du collège arriveront ici.',
          )),
    h(
      'p.footnote',
      parent
        ? 'Lecture seule : pour répondre, utilisez ÉcoleDirecte. Ouvrir un message le marque aussi comme lu sur ÉcoleDirecte.'
        : 'Lecture seule : pour répondre, passe par ÉcoleDirecte.',
    ),
  );
}

/** Texte d'un message : un paragraphe par ligne, adresses web cliquables. */
function messageText(text: string): HTMLElement {
  const url = /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
  return h(
    'div.mail-text',
    text
      .split('\n')
      .filter((line) => line.trim())
      .map((line) =>
        h(
          'p',
          line
            .split(url)
            .map((part, i) =>
              i % 2 === 1 ? h('a', { href: part, target: '_blank', rel: 'noopener noreferrer' }, part) : part,
            ),
        ),
      ),
  );
}

function shareBlock(d: MailDetail, actions: Actions): HTMLElement | null {
  const children: Child[] = state.data?.children ?? [];
  if (d.box !== 'family' || state.session?.me?.role !== 'parent' || !children.length) return null;
  const shared = new Set(d.sharedWith ?? []);
  return h(
    'section.block.share',
    sectionHead('Partager avec'),
    h(
      'div.share-chips',
      children.map((c) => {
        const on = shared.has(c.id);
        return h(
          `button.share-chip${on ? '.is-on' : ''}`,
          {
            type: 'button',
            style: { '--accent': `var(--c-${childColor(c.id)})` },
            'aria-pressed': String(on),
            onclick: () => {
              tap(on ? 8 : 16);
              const next = new Set(shared);
              if (on) next.delete(c.id);
              else next.add(c.id);
              actions.share(d.key, [...next]);
            },
          },
          h('span.avatar.avatar-xs', on ? icon('check', 14) : initial(c.name)),
          c.name,
        );
      }),
    ),
    h(
      'p.hint',
      shared.size
        ? 'Visible dans leur messagerie Orbite. Rien n’est envoyé sur ÉcoleDirecte.'
        : 'Une sortie, une réunion de classe ? Partagez-la : elle apparaîtra dans leur messagerie Orbite.',
    ),
  );
}

export function messageView(key: string, actions: Actions): HTMLElement {
  const entry = state.mailDetail.get(key);
  // Liens de pièces jointes valables 15 min : une copie de plus de 10 min est relue.
  if (!entry || (!entry.loading && entry.value && Date.now() - (entry.time ?? 0) > 10 * 60000))
    actions.loadMessage(key);
  const d = entry?.value ?? null;
  const owner = d?.childId ? state.data?.children.find((c) => c.id === d.childId) : null;
  return h(
    'div.screen.narrow.message',
    owner ? { style: accent(owner.id) } : null,
    sky({
      title: d?.subject ?? (entry?.error ? 'Message indisponible' : 'Message'),
      subtitle: d ? d.from : null,
      back: () => actions.go('messages'),
    }),
    entry?.error &&
      h(
        'div.inline-error',
        entry.error,
        h('button.link-button', { type: 'button', onclick: () => actions.loadMessage(key) }, 'Réessayer'),
      ),
    !d &&
      !entry?.error &&
      h(
        'div.bag-loading',
        [0, 1].map(() => h('div.skeleton')),
      ),
    d &&
      h(
        'article.mail-card.lift',
        h(
          'header.mail-card-head',
          h(`span.mail-avatar.role-${d.fromRole}`, senderInitial(d.from)),
          h(
            'span.mail-card-from',
            h('b', d.from),
            h(
              'small',
              d.date ? `${capitalize(longDay(d.date.slice(0, 10)))} à ${clockText(d.date.slice(11, 16))}` : '',
              owner && ` · messagerie de ${owner.name}`,
            ),
          ),
        ),
        d.text ? messageText(d.text) : h('p.empty-line', 'Ce message n’a pas de texte.'),
        d.files.length > 0 &&
          h(
            'ul.mail-files',
            d.files.map((f) =>
              h(
                'li',
                h(
                  'a.mail-file',
                  { href: f.url ?? '#', target: '_blank', rel: 'noopener noreferrer' },
                  h('span.mail-file-icon', icon('file', 20)),
                  h('span.mail-file-name', f.name),
                  icon('open', 18),
                ),
              ),
            ),
          ),
      ),
    d && shareBlock(d, actions),
    d && h('p.footnote', 'Pour répondre, utilisez ÉcoleDirecte. Les pièces jointes s’ouvrent dans le navigateur.'),
  );
}

/** Accueil famille : les derniers messages de la messagerie famille. */
export function familyMailBlock(actions: Actions): HTMLElement | null {
  const entry = state.mail.get('family');
  if (!entry) actions.loadMail('family');
  const items = entry?.value?.items ?? [];
  if (!items.length) return null;
  const unread = entry?.value?.unread ?? 0;
  return h(
    'section.block',
    sectionHead(
      'Messages',
      h(
        'button.link-button',
        {
          type: 'button',
          onclick: () => {
            state.mailScope = 'family';
            actions.go('messages');
          },
        },
        unread ? `${unread} non lu${unread > 1 ? 's' : ''}` : 'Tout voir',
      ),
    ),
    h(
      'ul.mail-list',
      items.slice(0, 3).map((i) => mailRow(i, actions)),
    ),
  );
}

/** Accueil élève : ses deux derniers messages, s'il y en a. */
export function mailCard(child: Child, actions: Actions): HTMLElement | null {
  const entry = state.mail.get(child.id);
  if (!entry) actions.loadMail(child.id);
  const items = entry?.value?.items ?? [];
  if (!items.length) return null;
  const unread = entry?.value?.unread ?? 0;
  return h(
    'section.block',
    sectionHead(
      'Messages',
      h(
        'button.link-button',
        { type: 'button', onclick: () => actions.go('messages') },
        unread ? `${unread} nouveau${unread > 1 ? 'x' : ''}` : 'Tout voir',
      ),
    ),
    h(
      'ul.mail-list',
      items.slice(0, 2).map((i) => mailRow(i, actions, false)),
    ),
  );
}

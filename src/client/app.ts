/**
 * Point d'entrée du navigateur : session, navigation par onglets, chargements.
 *
 * Navigation : l'ancre de l'URL (#accueil, #devoirs, #notes, #messages,
 * #vie-scolaire, #moi…) désigne l'écran ; le bouton retour du téléphone
 * fonctionne donc naturellement. Les onglets diffèrent selon le profil :
 * l'élève a son cartable, les parents la vie scolaire de la fratrie.
 */
import { api, ApiError } from './api.ts';
import { clear, h, icon, tap } from './dom.ts';
import { renderLock } from './lock.ts';
import { resetData, state, type Route } from './state.ts';
import { bagKey, bagView, kitSheet } from './bag-view.ts';
import { meView, sheet } from './settings.ts';
import { resetNotifications } from './push-view.ts';
import { parisHour } from '../shared/metrics.ts';
import { childColor, familyHome, gradesView, studentHome, tasksView, type Actions } from './views.ts';
import { lifeView } from './life-view.ts';
import { lessonKey } from './class-view.ts';
import { recapView } from './recap-view.ts';
import { docsView } from './docs-view.ts';
import { trainView } from './train-view.ts';
import { mailScope, messagesView, messageView } from './mail-view.ts';
import type { SessionInfo } from '../shared/types.ts';

const root = document.getElementById('app') as HTMLElement;
const HASH: Record<Route, string> = {
  home: 'accueil',
  child: 'eleve',
  bag: 'cartable',
  tasks: 'devoirs',
  grades: 'notes',
  progress: 'progres',
  messages: 'messages',
  message: 'message',
  life: 'vie-scolaire',
  recap: 'recap',
  docs: 'documents',
  train: 'entrainement',
  me: 'moi',
};

/** Couleurs des ciels pour la barre d'état du téléphone (mêmes valeurs que la feuille de style). */
const SKY: Record<string, [string, string]> = {
  comete: ['#4947c8', '#4d4c8e'],
  soleil: ['#b07212', '#856535'],
  lagon: ['#0d7784', '#256e76'],
  corail: ['#b13761', '#85445c'],
  menthe: ['#197a5b', '#2d6e58'],
  prune: ['#6d3eb2', '#624e8e'],
};

function routeFromHash(): Route {
  const [key = '', ...rest] = location.hash.replace('#', '').split('/');
  const route = (Object.entries(HASH).find(([, v]) => v === key)?.[0] as Route) || 'home';
  if (route === 'message') {
    try {
      state.mailOpen = decodeURIComponent(rest.join('/'));
    } catch {
      state.mailOpen = null;
    }
    return state.mailOpen ? 'message' : 'messages';
  }
  // Les progrès sont la troisième vue de l'onglet Notes.
  if (route === 'progress') {
    state.notesMode = 'progress';
    return 'grades';
  }
  return route;
}

function applyPrefs(): void {
  const doc = document.documentElement;
  const me = state.session?.me;
  doc.dataset.theme = me?.prefs.theme ?? 'auto';
  doc.dataset.reading = me?.prefs.reading ?? 'standard';
  doc.style.setProperty('--me', `var(--c-${me?.color ?? 'comete'})`);
  themeColor(me?.color ?? 'comete');
}

/** Barre d'état du téléphone à la couleur du ciel de l'écran affiché. */
function themeColor(color: string): void {
  const doc = document.documentElement;
  const dark =
    doc.dataset.theme === 'dark' ||
    (doc.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  const content = (SKY[color] ?? SKY.comete ?? ['#4947c8', '#4d4c8e'])[dark ? 1 : 0];
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])');
  if (!meta) {
    for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.remove();
    meta = h('meta', { name: 'theme-color', content });
    document.head.append(meta);
  }
  if (meta.content !== content) meta.content = content;
}

let toastTimer = 0;
function toast(message: string): void {
  document.querySelector('.toast')?.remove();
  const el = h('div.toast', { role: 'status' }, message);
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.remove(), 3200);
}

/* ---------- Chargements ---------- */

async function loadData(refresh = false): Promise<void> {
  if (state.dataLoading) return;
  state.dataLoading = true;
  if (refresh) render();
  try {
    const data = await api.data(refresh);
    state.data = data;
    state.dataTime = Date.now();
    state.dataError = null;
    // Les repères « nouveau » restent visibles pendant toute la visite.
    for (const k of data.fresh) state.fresh.add(k);
    const ids = data.children.map((c) => c.id);
    if (!state.selected || !ids.includes(state.selected)) state.selected = ids[0] ?? null;
    if (refresh) {
      for (const id of ids) state.homework.delete(id);
      toast('Données à jour.');
    }
    // Pastille de l'onglet Messages : boîte principale chargée en arrière-plan.
    const scope = mailScope();
    if (scope && !state.mail.has(scope)) actions.loadMail(scope);
    if (data.fresh.length && !state.seenSent) {
      state.seenSent = true;
      window.setTimeout(() => void api.seen().catch(() => undefined), 4000);
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return void boot();
    state.dataError = e instanceof ApiError ? e.message : 'Chargement impossible.';
  } finally {
    state.dataLoading = false;
    render();
  }
}

async function loadMembers(): Promise<void> {
  if (state.session?.me?.role !== 'parent') return;
  try {
    const { members, ed } = await api.admin.members();
    state.members = members;
    if (state.session) state.session.ed = ed;
    render();
  } catch {}
}

const actions: Actions = {
  go(route, childId) {
    if (childId) state.selected = childId;
    state.openTask = null;
    if (route === 'grades' || route === 'progress') state.notesMode = route === 'progress' ? 'progress' : 'recent';
    const target = '#' + HASH[route as Route];
    if (location.hash === target) render();
    else location.hash = target;
    window.scrollTo({ top: 0 });
  },
  select(childId) {
    state.selected = childId;
    state.openSubject = null;
    render();
  },
  toggleCheck(childId, homeworkId, done) {
    const list = new Set(state.data?.checks[childId] ?? []);
    if (done) list.add(homeworkId);
    else list.delete(homeworkId);
    if (state.data) state.data.checks[childId] = [...list];
    render();
    api
      .check(childId, homeworkId, done)
      .then((r) => {
        if (state.data) state.data.checks[childId] = r.checks;
      })
      .catch((e) => {
        toast(e instanceof ApiError ? e.message : 'Case non enregistrée.');
        void loadData();
      });
  },
  loadHomework(childId, more = false) {
    const current = state.homework.get(childId);
    if (current?.loading || current?.moreLoading) return;
    const hw = current ?? {
      items: [],
      dates: [],
      next: null,
      partial: false,
      loaded: false,
      loading: false,
      moreLoading: false,
      error: null,
    };
    if (more) hw.moreLoading = true;
    else hw.loading = true;
    hw.error = null;
    state.homework.set(childId, hw);
    // Rendu différé : cette fonction peut être appelée pendant la construction d'une vue.
    queueMicrotask(render);
    api
      .homework(childId, more ? hw.next : null)
      .then((page) => {
        hw.items = more ? [...hw.items, ...page.homework] : page.homework;
        hw.dates = more ? [...hw.dates, ...page.homeworkDates] : page.homeworkDates;
        hw.next = page.homeworkNext;
        hw.partial = page.homeworkPartial;
        hw.loaded = true;
      })
      .catch((e) => {
        hw.error = e instanceof ApiError ? e.message : 'Devoirs indisponibles.';
      })
      .finally(() => {
        hw.loading = false;
        hw.moreLoading = false;
        render();
      });
  },
  loadCoaching(childId) {
    if (state.coaching.has(childId)) return;
    const c = { text: null as string | null, loading: true, failed: false };
    state.coaching.set(childId, c);
    api
      .coaching(childId)
      .then((r) => {
        c.text = r.text;
      })
      .catch(() => {
        c.failed = true;
      })
      .finally(() => {
        c.loading = false;
        render();
      });
  },
  refresh() {
    tap();
    state.bags.clear();
    state.lives.clear();
    state.mail.clear();
    void loadData(true);
  },
  loadBag(childId, date) {
    const key = bagKey(childId, date);
    const current = state.bags.get(key);
    if (current?.loading) return;
    const entry = { day: current?.day ?? null, loading: true, error: null as string | null };
    state.bags.set(key, entry);
    api
      .bag(childId, date)
      .then((day) => {
        entry.day = day;
      })
      .catch((e) => {
        entry.error = e instanceof ApiError ? e.message : 'Cartable indisponible.';
      })
      .finally(() => {
        entry.loading = false;
        render();
      });
  },
  togglePacked(childId, date, itemId, packed) {
    for (const b of state.bags.values()) {
      const d = b.day;
      if (!d || d.date !== date || !b) continue;
      const set = new Set(d.packed);
      if (packed) set.add(itemId);
      else set.delete(itemId);
      d.packed = [...set];
    }
    render();
    api.pack(childId, date, itemId, packed).catch((e) => {
      toast(e instanceof ApiError ? e.message : 'Case non enregistrée.');
    });
  },
  editKit(child) {
    const day = state.bags.get(bagKey(child.id, state.bagDay))?.day;
    if (!day) return;
    kitSheet(child, day, sheet, async (kit) => {
      try {
        await api.kit(child.id, kit);
        for (const key of [...state.bags.keys()]) if (key.startsWith(child.id + '|')) state.bags.delete(key);
        toast('Matériel enregistré.');
        render();
      } catch (e) {
        toast(e instanceof ApiError ? e.message : 'Matériel non enregistré.');
      }
    });
  },

  loadMail(scope, refresh = false) {
    const current = state.mail.get(scope);
    if (current?.loading) return;
    const entry = { value: current?.value ?? null, loading: true, error: null as string | null };
    state.mail.set(scope, entry);
    if (refresh) queueMicrotask(render);
    api
      .messages(scope === 'family' ? null : scope, refresh)
      .then((list) => {
        entry.value = list;
        if (scope === mailScope()) state.unread = list.unread;
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) return void boot();
        entry.error = e instanceof ApiError ? e.message : 'Messages indisponibles.';
      })
      .finally(() => {
        entry.loading = false;
        render();
      });
  },
  openMessage(key) {
    location.hash = '#message/' + encodeURIComponent(key);
    window.scrollTo({ top: 0 });
  },
  loadMessage(key) {
    const current = state.mailDetail.get(key);
    if (current?.loading) return;
    const entry = {
      value: current?.value ?? null,
      loading: true,
      error: null as string | null,
      time: current?.time ?? 0,
    };
    state.mailDetail.set(key, entry);
    queueMicrotask(render);
    api
      .message(key)
      .then((detail) => {
        entry.value = detail;
        entry.time = Date.now();
        // Message ouvert : plus « nouveau » dans les listes déjà chargées.
        for (const [scope, list] of state.mail) {
          const item = list.value?.items.find((i) => i.key === key);
          if (!item?.isNew || !list.value) continue;
          item.isNew = false;
          list.value.unread = Math.max(0, list.value.unread - 1);
          if (scope === mailScope()) state.unread = list.value.unread;
        }
      })
      .catch((e) => {
        // Partage retiré ou message disparu : on n'affiche plus l'ancienne copie.
        if (e instanceof ApiError && (e.status === 404 || e.status === 403)) entry.value = null;
        entry.error = e instanceof ApiError ? e.message : 'Message indisponible.';
      })
      .finally(() => {
        entry.loading = false;
        render();
      });
  },
  share(key, childIds) {
    const detail = state.mailDetail.get(key)?.value;
    const previous = detail?.sharedWith ?? [];
    const apply = (ids: string[]) => {
      if (detail) detail.sharedWith = ids;
      for (const list of state.mail.values()) {
        const item = list.value?.items.find((i) => i.key === key);
        if (item) item.sharedWith = ids;
      }
    };
    apply(childIds);
    render();
    api
      .share(key, childIds)
      .then((r) => {
        apply(r.sharedWith);
        // Les boîtes des enfants concernés seront relues à leur prochaine ouverture.
        for (const id of new Set([...previous, ...r.sharedWith])) state.mail.delete(id);
        toast(r.sharedWith.length ? 'Message partagé.' : 'Partage retiré.');
        render();
      })
      .catch((e) => {
        apply(previous);
        toast(e instanceof ApiError ? e.message : 'Partage non enregistré.');
        render();
      });
  },
  loadLife(childId, refresh = false) {
    const current = state.lives.get(childId);
    if (current?.loading) return;
    const entry = { value: current?.value ?? null, loading: true, error: null as string | null };
    state.lives.set(childId, entry);
    if (refresh) queueMicrotask(render);
    api
      .schoolLife(childId, refresh)
      .then((life) => {
        entry.value = life;
      })
      .catch((e) => {
        entry.error = e instanceof ApiError ? e.message : 'Vie scolaire indisponible.';
      })
      .finally(() => {
        entry.loading = false;
        render();
      });
  },

  loadLessons(childId, date, refresh = false) {
    const key = lessonKey(childId, date);
    const current = state.lessons.get(key);
    if (current?.loading) return;
    const entry = { value: current?.value ?? null, loading: true, error: null as string | null };
    state.lessons.set(key, entry);
    if (refresh) queueMicrotask(render);
    api
      .lessons(childId, date)
      .then((r) => {
        entry.value = r.lessons;
      })
      .catch((e) => {
        entry.error = e instanceof ApiError ? e.message : 'Cahier de textes indisponible.';
      })
      .finally(() => {
        entry.loading = false;
        render();
      });
  },

  rerender: () => render(),
};

/* ---------- Rendu ---------- */

function tabs(): [Route, string, string][] {
  const parent = state.session?.me?.role === 'parent';
  return parent
    ? [
        ['home', 'Famille', 'family'],
        ['messages', 'Messages', 'mail'],
        ['life', 'Vie sco', 'shield'],
        ['tasks', 'Devoirs', 'tasks'],
        ['grades', 'Notes', 'grades'],
      ]
    : [
        ['home', 'Accueil', 'home'],
        ['bag', 'Cartable', 'bag'],
        ['tasks', 'Devoirs', 'tasks'],
        ['grades', 'Notes', 'grades'],
        ['messages', 'Messages', 'mail'],
      ];
}

function currentTab(): Route {
  const r = state.route;
  if (r === 'child' || r === 'train') return 'home';
  if (r === 'message') return 'messages';
  if (r === 'progress') return 'grades';
  if (r === 'life' && state.session?.me?.role !== 'parent') return 'home';
  if (r === 'bag' && state.session?.me?.role === 'parent') return 'home';
  return r;
}

/**
 * Barre d'onglets flottante (rail vertical sur grand écran). Elle reste dans la
 * page d'un rendu à l'autre : seuls l'onglet actif, la bulle qui glisse vers lui
 * et les pastilles changent, ce qui permet l'animation.
 */
function updateTabBar(shell: HTMLElement): void {
  const list = tabs();
  const signature = list.map((t) => t[0]).join(',');
  let bar = shell.querySelector<HTMLElement>('.tabbar');
  if (!bar || bar.dataset.tabs !== signature) {
    bar?.remove();
    bar = h(
      'nav.tabbar',
      { 'aria-label': 'Navigation principale', dataset: { tabs: signature } },
      h('span.tab-blob', { 'aria-hidden': 'true' }),
      list.map(([route, label, ico]) =>
        h(
          'a.tab',
          { href: '#' + HASH[route], dataset: { route }, onclick: () => tap(5) },
          h('span.tab-icon', icon(ico, 24), h('span.tab-badge', { hidden: true })),
          h('span.tab-label', label),
        ),
      ),
    );
    shell.append(bar);
  }
  const current = currentTab();
  const index = list.findIndex(([r]) => r === current);
  bar.style.setProperty('--i', String(Math.max(0, index)));
  bar.classList.toggle('has-active', index >= 0);
  for (const a of bar.querySelectorAll<HTMLAnchorElement>('.tab')) {
    const active = a.dataset.route === current;
    a.classList.toggle('is-active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
    const badge = a.querySelector<HTMLElement>('.tab-badge');
    if (!badge) continue;
    const count = a.dataset.route === 'messages' ? state.unread : 0;
    badge.hidden = count === 0;
    badge.textContent = count > 9 ? '9+' : String(count);
  }
}

function waiting(text: string): HTMLElement {
  return h('div.screen', h('div.empty.empty-center', h('p.empty-title', text)));
}

function currentView(): HTMLElement {
  const me = state.session?.me;
  if (!me) return h('div');
  if (state.route === 'me')
    return meView({
      rerender: render,
      back: () => actions.go('home'),
      reloadSession: async () => {
        state.session = await api.session();
        applyPrefs();
      },
      reloadData: () => void loadData(),
      logout: () => void logout(),
      toast,
    });
  if (!state.data) {
    if (state.dataError) return waiting(state.dataError);
    return h(
      'div.screen.loading-screen',
      h('div.skeleton.skeleton-title'),
      h('div.skeleton.skeleton-orbit'),
      h('div.skeleton.skeleton-row'),
      h('div.skeleton.skeleton-row'),
    );
  }
  const children = state.data.children;
  if (me.role === 'child' && !children.length) {
    return h(
      'div.screen',
      h(
        'div.empty.empty-center',
        h('p.empty-title', `Bientôt prêt, ${me.name}`),
        h(
          'p.empty-text',
          state.data.updatedAt
            ? 'Ton profil n’est pas encore relié à ton compte ÉcoleDirecte. Demande à un parent de le faire dans Réglages.'
            : 'Un parent doit d’abord connecter ÉcoleDirecte.',
        ),
      ),
    );
  }
  if (state.route === 'home' && me.role === 'parent') return familyHome(actions);
  if (state.route === 'messages') return messagesView(actions);
  if (state.route === 'recap' && me.role === 'parent') return recapView(actions);
  if (state.route === 'docs' && me.role === 'parent') return docsView(actions);
  if (state.route === 'message' && state.mailOpen) return messageView(state.mailOpen, actions);
  const child = children.find((c) => c.id === state.selected) ?? children[0];
  if (!child) return familyHome(actions);
  switch (state.route) {
    case 'bag':
      return bagView(child, actions);
    case 'tasks':
      return tasksView(child, actions);
    case 'grades':
    case 'progress':
      return gradesView(child, actions);
    case 'life':
      return lifeView(child, actions);
    case 'train':
      return me.role === 'child' ? trainView(child, actions) : studentHome(child, actions, true);
    default:
      return studentHome(child, actions, me.role === 'parent');
  }
}

/** Écran affiché : sert à ne jouer l'animation d'entrée qu'au changement d'écran. */
function screenKey(): string {
  return [state.route, state.selected, state.mailOpen, state.route === 'messages' ? state.mailScope : ''].join('|');
}
let lastScreen = '';

let rendering = false;
function render(): void {
  if (rendering || !state.session?.me) return;
  rendering = true;
  try {
    document.documentElement.dataset.screen = 'app';
    let shell = root.querySelector<HTMLElement>('.shell');
    if (!shell) {
      clear(root);
      shell = h('div.shell', h('main.view', { id: 'view' }));
      root.append(shell);
      lastScreen = '';
    }
    const view = shell.querySelector('.view') as HTMLElement;
    const key = screenKey();
    const screen = currentView();
    if (key !== lastScreen) screen.classList.add('is-entering');
    lastScreen = key;
    clear(view);
    view.append(screen);
    updateTabBar(shell);
    const sel = state.selected;
    const own =
      state.route === 'me' ||
      state.route === 'home' ||
      state.route === 'recap' ||
      state.route === 'docs' ||
      state.route === 'messages' ||
      state.route === 'message' ||
      state.session.me.role !== 'parent' ||
      !sel;
    const color = own ? state.session.me.color : childColor(sel);
    shell.style.setProperty('--accent', `var(--c-${color})`);
    // Un écran peut imposer la couleur d'un élève (boîte d'un enfant, message de sa messagerie).
    const forced = /--accent:\s*var\(--c-(\w+)\)/.exec(screen.getAttribute('style') ?? '')?.[1];
    themeColor(forced ?? color);
    shell.classList.toggle('is-refreshing', state.dataLoading);
  } finally {
    rendering = false;
  }
}

async function logout(): Promise<void> {
  try {
    await api.logout();
  } catch {}
  resetData();
  await boot();
}

function unlocked(session: SessionInfo): void {
  state.session = session;
  resetData();
  resetNotifications();
  applyPrefs();
  clear(root);
  state.route = routeFromHash();
  // Le matin, un élève arrive directement sur son cartable du jour.
  const hour = parisHour(new Date());
  if (!location.hash && session.me?.role === 'child' && hour >= 5 && hour < 9) state.route = 'bag';
  render();
  void loadData();
  void loadMembers();
}

async function boot(): Promise<void> {
  let session: SessionInfo;
  try {
    session = await api.session();
  } catch (e) {
    clear(root);
    root.append(
      h(
        'div.boot-error',
        h('p', e instanceof ApiError ? e.message : 'Orbite est injoignable.'),
        h('button.button', { type: 'button', onclick: () => void boot() }, 'Réessayer'),
      ),
    );
    return;
  }
  state.session = session;
  applyPrefs();
  if (!session.me) {
    renderLock(root, session, unlocked);
    return;
  }
  unlocked(session);
}

window.addEventListener('hashchange', () => {
  state.route = routeFromHash();
  render();
});

// Retour sur l'appli après un moment : données rafraîchies si elles ont plus de 10 minutes.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.session?.me && Date.now() - state.dataTime > 600000)
    void loadData();
});

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyPrefs);

if ('serviceWorker' in navigator && location.protocol === 'https:')
  void navigator.serviceWorker.register('/sw.js').catch(() => undefined);

void boot();

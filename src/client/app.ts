/**
 * Point d'entrée du navigateur : session, navigation par onglets, chargements.
 *
 * Navigation : l'ancre de l'URL (#accueil, #devoirs, #notes, #progres, #moi)
 * désigne l'onglet ; le bouton retour du téléphone fonctionne donc naturellement.
 */
import { api, ApiError } from './api.ts';
import { clear, h, icon, tap } from './dom.ts';
import { renderLock } from './lock.ts';
import { meView } from './settings.ts';
import { resetData, state, type Route } from './state.ts';
import { childColor, familyHome, gradesView, progressView, studentHome, tasksView, type Actions } from './views.ts';
import type { SessionInfo } from '../shared/types.ts';

const root = document.getElementById('app') as HTMLElement;
const HASH: Record<Route, string> = {
  home: 'accueil',
  child: 'eleve',
  tasks: 'devoirs',
  grades: 'notes',
  progress: 'progres',
  me: 'moi',
};

function routeFromHash(): Route {
  const key = location.hash.replace('#', '').split('/')[0] ?? '';
  return (Object.entries(HASH).find(([, v]) => v === key)?.[0] as Route) || 'home';
}

function applyPrefs(): void {
  const doc = document.documentElement;
  const me = state.session?.me;
  doc.dataset.theme = me?.prefs.theme ?? 'auto';
  doc.dataset.reading = me?.prefs.reading ?? 'standard';
  doc.style.setProperty('--me', `var(--c-${me?.color ?? 'comete'})`);
  const dark =
    doc.dataset.theme === 'dark' ||
    (doc.dataset.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]:not([media])')?.remove();
  document.head.append(h('meta', { name: 'theme-color', content: dark ? '#0D1026' : '#F3F5FA' }));
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
    void loadData(true);
  },
  rerender: () => render(),
};

/* ---------- Rendu ---------- */

function tabBar(): HTMLElement {
  const me = state.session?.me;
  const parent = me?.role === 'parent';
  const tabs: [Route, string, string][] = [
    ['home', parent ? 'Famille' : 'Accueil', parent ? 'family' : 'home'],
    ['tasks', 'Devoirs', 'tasks'],
    ['grades', 'Notes', 'grades'],
    ['progress', 'Progrès', 'chart'],
    ['me', parent ? 'Réglages' : 'Moi', 'user'],
  ];
  const current = state.route === 'child' ? 'home' : state.route;
  return h(
    'nav.tabbar',
    { 'aria-label': 'Navigation principale' },
    tabs.map(([route, label, ico]) =>
      h(
        `a.tab${current === route ? '.is-active' : ''}`,
        {
          href: '#' + HASH[route],
          'aria-current': current === route ? 'page' : null,
          onclick: () => tap(5),
        },
        icon(ico, 24),
        h('span', label),
      ),
    ),
  );
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
  const child = children.find((c) => c.id === state.selected) ?? children[0];
  if (!child) return familyHome(actions);
  switch (state.route) {
    case 'tasks':
      return tasksView(child, actions);
    case 'grades':
      return gradesView(child, actions);
    case 'progress':
      return progressView(child, actions);
    default:
      return studentHome(child, actions, me.role === 'parent');
  }
}

let rendering = false;
function render(): void {
  if (rendering || !state.session?.me) return;
  rendering = true;
  try {
    document.documentElement.dataset.screen = 'app';
    let shell = root.querySelector<HTMLElement>('.shell');
    if (!shell) {
      clear(root);
      shell = h('div.shell', h('main.view', { id: 'view' }), tabBar());
      root.append(shell);
    }
    const view = shell.querySelector('.view') as HTMLElement;
    clear(view);
    view.append(currentView());
    shell.querySelector('.tabbar')?.replaceWith(tabBar());
    const sel = state.selected;
    const own = state.route === 'me' || state.route === 'home' || state.session.me.role !== 'parent' || !sel;
    shell.style.setProperty('--accent', `var(--c-${own ? state.session.me.color : childColor(sel)})`);
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
  applyPrefs();
  clear(root);
  state.route = routeFromHash();
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

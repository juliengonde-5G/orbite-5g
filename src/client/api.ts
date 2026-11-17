/**
 * Appels au serveur Orbite. Les POST portent l'en-tête `X-Orbite-Client` exigé
 * par le serveur (protection CSRF) ; les erreurs deviennent des `ApiError`
 * dont le message est rédigé pour l'utilisateur.
 */
import type { ReportKind, ReportView } from '../shared/releases.ts';
import type { HubCreated, HubOverview } from '../shared/hub.ts';
import type { SheetView, SkillsPage } from '../shared/skills.ts';
import type { ModuleResult, ModuleView, SupportMonitor, SupportStatus } from '../shared/support.ts';
import type {
  AuthResult,
  BagDay,
  ClaudeKeyStatus,
  DocumentList,
  Kit,
  EdStatus,
  FamilyDashboard,
  HomeworkPage,
  Lesson,
  MailDetail,
  MailList,
  MemberView,
  PushPrefs,
  PushStatus,
  Carnet,
  SchoolLife,
  Prefs,
  SessionInfo,
} from '../shared/types.ts';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Préfixe de la famille (`/f/dupont-k7x2`), fourni par le serveur dans la page ; vide pour la famille « maison ». */
export const BASE = document.querySelector('meta[name="orbite-base"]')?.getAttribute('content') ?? '';

async function callAt<T>(base: string, method: 'GET' | 'POST', path: string, data?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(base + path, {
      method,
      credentials: 'same-origin',
      headers: method === 'POST' ? { 'Content-Type': 'application/json', 'X-Orbite-Client': '1' } : {},
      body: method === 'POST' ? JSON.stringify(data ?? {}) : null,
    });
  } catch {
    throw new ApiError('Pas de connexion au serveur Orbite. Vérifie le réseau.', 0);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {}
  if (!res.ok) {
    const message = (body as { error?: string } | null)?.error || `Erreur ${res.status}.`;
    throw new ApiError(message, res.status);
  }
  return body as T;
}

const call = <T>(method: 'GET' | 'POST', path: string, data?: unknown) => callAt<T>(BASE, method, path, data);

/** Plateforme multi-familles : toujours la racine du serveur, jamais le préfixe d'une famille. */
export const hubApi = {
  check: (token: string) => callAt<{ label: string }>('', 'POST', '/api/hub/invite/check', { token }),
  create: (token: string, familyName: string, adminName: string) =>
    callAt<HubCreated>('', 'POST', '/api/hub/family/create', { token, familyName, adminName }),
  /** Choisit le PIN du parent dans la famille tout juste créée (le code d'installation vient de `create`). */
  setupParent: (url: string, name: string, pin: string, code: string) =>
    callAt<SessionInfo>(url.replace(/\/$/, ''), 'POST', '/api/setup', { name, pin, code }),
  families: () => callAt<HubOverview>('', 'GET', '/api/hub/families'),
  invite: (label: string) => callAt<{ path: string } & HubOverview>('', 'POST', '/api/hub/invite', { label }),
  remove: (slug: string) => callAt<HubOverview>('', 'POST', '/api/hub/family/delete', { slug }),
  update: (slug: string, changes: { disabled?: boolean; dailyLimit?: number }) =>
    callAt<HubOverview>('', 'POST', '/api/hub/family/update', { slug, ...changes }),
};

export const api = {
  session: () => call<SessionInfo>('GET', '/api/session'),
  setup: (who: { memberId?: string; name?: string }, pin: string, code?: string) =>
    call<SessionInfo>('POST', '/api/setup', { ...who, pin, ...(code ? { code } : {}) }),
  login: (who: { memberId?: string; name?: string }, pin: string) =>
    call<SessionInfo>('POST', '/api/login', { ...who, pin }),
  activate: (who: { memberId?: string; name?: string }, code: string, pin: string) =>
    call<SessionInfo>('POST', '/api/activate', { ...who, code, pin }),
  logout: () => call<SessionInfo>('POST', '/api/logout'),
  prefs: (prefs: Partial<Prefs> & { color?: string }) => call<MemberView>('POST', '/api/prefs', prefs),
  data: (refresh = false) => call<FamilyDashboard>('POST', '/api/data', { refresh }),
  seen: () => call<{ ok: true }>('POST', '/api/seen'),
  homework: (childId: string, cursor: number | null = null, refresh = false) =>
    call<HomeworkPage>('POST', '/api/homework', { childId, cursor, refresh }),
  check: (childId: string, homeworkId: string, done: boolean) =>
    call<{ checks: string[] }>('POST', '/api/check', { childId, homeworkId, done }),
  coaching: (childId: string) => call<{ text: string }>('POST', '/api/coaching', { childId }),
  bag: (childId: string, date: string | null) => call<BagDay>('POST', '/api/bag', { childId, date }),
  pack: (childId: string, date: string, itemId: string, packed: boolean) =>
    call<{ packed: string[] }>('POST', '/api/bag/pack', { childId, date, itemId, packed }),
  kit: (childId: string, kit: Kit) => call<Kit>('POST', '/api/bag/kit', { childId, kit }),
  /** `childId` absent : messagerie famille (parents) ou sa propre boîte (élève). */
  messages: (childId: string | null, refresh = false) =>
    call<MailList>('POST', '/api/messages', { ...(childId ? { childId } : {}), refresh }),
  message: (key: string) => call<MailDetail>('POST', '/api/message', { key }),
  share: (key: string, childIds: string[]) =>
    call<{ sharedWith: string[] }>('POST', '/api/message/share', { key, childIds }),
  carnet: (childId: string, refresh = false) => call<Carnet>('POST', '/api/carnet', { childId, refresh }),
  schoolLife: (childId: string, refresh = false) => call<SchoolLife>('POST', '/api/schoollife', { childId, refresh }),
  documents: (refresh = false) => call<DocumentList>('POST', '/api/documents', { refresh }),
  lessons: (childId: string, date: string) =>
    call<{ date: string; lessons: Lesson[] }>('POST', '/api/lessons', { childId, date }),
  report: (kind: ReportKind, text: string, screen: string) =>
    call<{ ok: true }>('POST', '/api/report', { kind, text, screen }),
  support: {
    status: (childId: string) => call<SupportStatus>('POST', '/api/support', { childId }),
    monitor: (childId: string) => call<SupportMonitor>('POST', '/api/support/monitor', { childId }),
    enable: (childId: string, enabled: boolean) =>
      call<SupportStatus>('POST', '/api/support/enable', { childId, enabled }),
    start: (childId: string, key: string) => call<ModuleView>('POST', '/api/support/start', { childId, key }),
    answer: (childId: string, sessionId: string, answers: (number | null)[], seconds: number) =>
      call<ModuleResult>('POST', '/api/support/answer', { childId, sessionId, answers, seconds }),
  },
  skills: {
    page: (childId: string) => call<SkillsPage>('POST', '/api/skills', { childId }),
    sheet: (childId: string, key: string, refresh = false) =>
      call<SheetView>('POST', '/api/skills/sheet', { childId, key, refresh }),
    aids: (childId: string, aids: string[]) => call<{ aids: string[] }>('POST', '/api/skills/aids', { childId, aids }),
    adapt: (childId: string, dys?: boolean) =>
      call<{ dys: boolean }>('POST', '/api/skills/adapt', dys === undefined ? { childId } : { childId, dys }),
  },
  push: {
    status: () => call<PushStatus>('GET', '/api/push'),
    subscribe: (subscription: unknown) => call<PushStatus>('POST', '/api/push/subscribe', { subscription }),
    unsubscribe: () => call<PushStatus>('POST', '/api/push/unsubscribe'),
    prefs: (prefs: Partial<PushPrefs>) => call<PushStatus>('POST', '/api/push/prefs', { prefs }),
    test: () => call<{ sent: number }>('POST', '/api/push/test'),
  },
  admin: {
    reports: () => call<{ items: ReportView[]; open: number }>('GET', '/api/admin/reports'),
    resolveReport: (id: string, done: boolean) =>
      call<{ items: ReportView[]; open: number }>('POST', '/api/admin/report/resolve', { id, done }),
    removeReport: (id: string) =>
      call<{ items: ReportView[]; open: number }>('POST', '/api/admin/report/remove', { id }),
    members: () => call<{ members: MemberView[]; ed: EdStatus }>('GET', '/api/admin/members'),
    connect: (username: string, password: string, remember: boolean) =>
      call<AuthResult>('POST', '/api/admin/ed/connect', { username, password, remember }),
    verify: (input: { choice?: number; code?: string }) => call<AuthResult>('POST', '/api/admin/ed/verify', input),
    disconnect: () => call<EdStatus>('POST', '/api/admin/ed/disconnect'),
    claude: () => call<ClaudeKeyStatus>('GET', '/api/admin/claude'),
    setClaudeKey: (key: string) => call<ClaudeKeyStatus>('POST', '/api/admin/claude', { key }),
    removeClaudeKey: () => call<ClaudeKeyStatus>('POST', '/api/admin/claude/remove'),
    add: (name: string, role: 'parent' | 'child', grade: string) =>
      call<MemberView>('POST', '/api/admin/member/add', { name, role, grade }),
    update: (memberId: string, changes: Record<string, unknown>) =>
      call<MemberView>('POST', '/api/admin/member/update', { memberId, ...changes }),
    remove: (memberId: string) => call<{ ok: true }>('POST', '/api/admin/member/remove', { memberId }),
    code: (memberId: string) => call<{ code: string; expires: number }>('POST', '/api/admin/member/code', { memberId }),
    signout: (memberId: string) => call<{ ok: true }>('POST', '/api/admin/member/signout', { memberId }),
  },
};

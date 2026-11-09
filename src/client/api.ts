/**
 * Appels au serveur Orbite. Les POST portent l'en-tête `X-Orbite-Client` exigé
 * par le serveur (protection CSRF) ; les erreurs deviennent des `ApiError`
 * dont le message est rédigé pour l'utilisateur.
 */
import type {
  AuthResult,
  BagDay,
  ClaudeKeyStatus,
  Kit,
  EdStatus,
  FamilyDashboard,
  HomeworkPage,
  MailDetail,
  MailList,
  MemberView,
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

async function call<T>(method: 'GET' | 'POST', path: string, data?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
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
  schoolLife: (childId: string, refresh = false) => call<SchoolLife>('POST', '/api/schoollife', { childId, refresh }),
  admin: {
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

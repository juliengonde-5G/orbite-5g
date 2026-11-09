/**
 * Lien unique avec ÉcoleDirecte pour toute la famille.
 *
 * Rôle : contrairement à Orbite d'origine (une connexion par navigateur), le
 * serveur détient ici une seule connexion, celle du compte parent. Les enfants et
 * l'autre parent n'en connaissent jamais les identifiants : ils voient seulement
 * ce que leur profil autorise (`server.ts`).
 *
 * Fonctionnement :
 * - `connect` / `verify` : le parent administrateur saisit ses identifiants dans
 *   l'appli et répond à la question de sécurité éventuelle.
 * - Reconnexion automatique (option choisie à la connexion) : identifiant, mot de
 *   passe et facteurs de confiance sont gardés dans le coffre chiffré. Quand le
 *   jeton expire, le serveur se reconnecte seul. Si ÉcoleDirecte repose une
 *   question ou demande un code TOTP, le lien passe en « attention » et
 *   l'administrateur est invité à se reconnecter.
 * - Tous les appels passent par une file : ÉcoleDirecte fait tourner son jeton à
 *   chaque réponse, deux appels simultanés casseraient la session.
 * - Cache : tableau de bord 10 min, devoirs 10 min par élève, emploi du temps et
 *   vie scolaire 15 min, messages 5 min (contenu ouvert 30 min). Le dernier
 *   tableau de bord est conservé chiffré pour s'afficher même si ÉcoleDirecte est
 *   indisponible ; messages et vie scolaire ne sont jamais écrits sur disque.
 * - Historique : date de première apparition de chaque note, pour signaler les
 *   nouveautés à chaque membre.
 */
import {
  EcoleDirecte,
  EdError,
  type EdDocument,
  type EdFile,
  type EdMail,
  type EdMailDetail,
  type Factor,
  type SavedAuth,
  type VerifyInput,
} from './ecoledirecte.ts';
import type { Vault } from './vault.ts';
import { noteKey, parisHour } from '../shared/metrics.ts';
import type {
  AuthResult,
  AuthState,
  Course,
  Dashboard,
  EdStatus,
  HomeworkPage,
  Lesson,
  SchoolInfo,
  SchoolLife,
} from '../shared/types.ts';

export interface EdClient {
  state: AuthState;
  trusted: Factor[];
  clear(): void;
  login(username: string, password: string, factors?: Factor[]): Promise<AuthResult>;
  verify(input: VerifyInput): Promise<AuthResult>;
  dashboard(): Promise<Dashboard>;
  homeworkForChild(childId: string, options: { cursor: number | null }): Promise<HomeworkPage>;
  timetableForChild(childId: string, from: string, to: string): Promise<Course[]>;
  lessonsForChild(childId: string, date: string): Promise<Lesson[]>;
  documents(): Promise<EdDocument[]>;
  documentFile(id: string): Promise<EdFile>;
  schoolInfosForChild(childId: string): Promise<SchoolInfo[]>;
  mailbox(childId: string | null): Promise<EdMail[]>;
  mail(childId: string | null, id: string): Promise<EdMailDetail>;
  mailFile(fileId: string): Promise<EdFile>;
  schoolLifeForChild(childId: string): Promise<SchoolLife>;
  exportSession(): SavedAuth | null;
  restoreSession(saved: unknown): void;
}

interface EdDoc {
  version: 1;
  username: string | null;
  /** Présent uniquement si la reconnexion automatique a été choisie. */
  password: string | null;
  factors: Factor[];
  auth: SavedAuth | null;
  attention: string | null;
  lastSync: string | null;
}

interface CacheDoc {
  version: 1;
  dashboard: Dashboard | null;
  time: number;
}

interface HistoryDoc {
  version: 1;
  /** Clé de note → date de première apparition (ms) ; 0 pour les notes déjà là au premier chargement. */
  firstSeen: Record<string, number>;
}

const DASHBOARD_TTL = 10 * 60000;
const HOMEWORK_TTL = 10 * 60000;
const EMPTY: EdDoc = {
  version: 1,
  username: null,
  password: null,
  factors: [],
  auth: null,
  attention: null,
  lastSync: null,
};

export function maskAccount(value: string | null): string | null {
  if (!value) return null;
  if (value.length <= 4) return value[0] + '•••';
  return value.slice(0, 2) + '•••' + value.slice(-2);
}

export class EdService {
  private readonly vault: Vault;
  private readonly factory: () => EdClient;
  private client: EdClient;
  private doc: EdDoc;
  private cache: CacheDoc;
  private history: HistoryDoc;
  private queue: Promise<unknown> = Promise.resolve();
  private homeworkCache = new Map<string, { time: number; value: HomeworkPage }>();
  private timetableCache = new Map<string, { time: number; value: Course[] }>();
  private lessonCache = new Map<string, { time: number; value: Lesson[] }>();
  private docCache: { time: number; value: EdDocument[] } | null = null;
  private infoCache = new Map<string, { time: number; value: SchoolInfo[] }>();
  private mailCache = new Map<string, { time: number; value: EdMail[] }>();
  private mailDetails = new Map<string, { time: number; value: EdMailDetail }>();
  private lifeCache = new Map<string, { time: number; value: SchoolLife }>();
  /** Saisie en cours (attente de vérification) : jamais écrite sur disque. */
  private pending: { username: string; password: string; remember: boolean } | null = null;

  /** Âge minimal du cache, même pour une actualisation forcée (protège ÉcoleDirecte et le compte). */
  private readonly floor: number;

  constructor(vault: Vault, factory: () => EdClient = () => new EcoleDirecte(), floor = 60000) {
    this.vault = vault;
    this.factory = factory;
    this.floor = floor;
    this.client = factory();
    this.doc = { ...EMPTY, ...vault.load<EdDoc>('ecoledirecte', EMPTY) };
    this.cache = vault.load<CacheDoc>('cache', { version: 1, dashboard: null, time: 0 });
    this.history = vault.load<HistoryDoc>('history', { version: 1, firstSeen: {} });
    if (this.doc.auth) {
      try {
        this.client.restoreSession(this.doc.auth);
      } catch {
        this.doc.auth = null;
      }
    }
  }

  /** Exécute `run` après les appels déjà en file (jamais deux appels ÉcoleDirecte en parallèle). */
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private persist(): void {
    this.doc.auth = this.client.exportSession();
    this.vault.save('ecoledirecte', this.doc);
  }

  get hasAccount(): boolean {
    return !!this.doc.username && (this.client.state === 'authenticated' || !!this.doc.password);
  }

  status(): EdStatus {
    const students = (this.cache.dashboard?.children ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      className: c.className,
    }));
    let link: EdStatus['link'] = 'disconnected';
    if (this.pending && ['question', 'totp'].includes(this.client.state)) link = 'pending';
    else if (this.doc.attention) link = 'attention';
    else if (this.hasAccount) link = 'connected';
    return {
      link,
      account: maskAccount(this.doc.username),
      autoReconnect: !!this.doc.password,
      lastSync: this.doc.lastSync,
      message: this.doc.attention,
      students,
    };
  }

  connect(username: unknown, password: unknown, remember: unknown): Promise<AuthResult> {
    if (
      typeof username !== 'string' ||
      !username.trim() ||
      username.length > 256 ||
      typeof password !== 'string' ||
      !password ||
      password.length > 1024
    )
      return Promise.reject(new EdError('Renseigne l’identifiant et le mot de passe ÉcoleDirecte.', 400));
    return this.serial(async () => {
      const user = username.trim();
      // Facteurs déjà obtenus pour ce même compte : la question n'est pas reposée.
      const factors = this.doc.username === user ? this.doc.factors : [];
      this.client.clear();
      this.client = this.factory();
      this.pending = { username: user, password, remember: remember !== false };
      try {
        const result = await this.client.login(user, password, factors);
        if (result.state === 'authenticated') this.accept();
        return result;
      } catch (e) {
        this.pending = null;
        throw e;
      }
    });
  }

  verify(input: VerifyInput): Promise<AuthResult> {
    return this.serial(async () => {
      if (!this.pending) throw new EdError('Relance la connexion à ÉcoleDirecte.', 400);
      try {
        const result = await this.client.verify(input);
        if (result.state === 'authenticated') this.accept();
        return result;
      } catch (e) {
        if (this.client.state === 'anonymous') this.pending = null;
        throw e;
      }
    });
  }

  private accept(): void {
    const pending = this.pending;
    if (!pending) return;
    const sameAccount = this.doc.username === pending.username;
    this.doc.username = pending.username;
    this.doc.password = pending.remember ? pending.password : null;
    if (this.client.trusted.length) this.doc.factors = this.client.trusted;
    else if (!sameAccount) this.doc.factors = [];
    this.doc.attention = null;
    this.pending = null;
    this.cache = { version: 1, dashboard: null, time: 0 };
    this.clearCaches();
    this.persist();
  }

  private clearCaches(): void {
    this.homeworkCache.clear();
    this.timetableCache.clear();
    this.lessonCache.clear();
    this.docCache = null;
    this.infoCache.clear();
    this.mailCache.clear();
    this.mailDetails.clear();
    this.lifeCache.clear();
  }

  disconnect(): Promise<void> {
    return this.serial(async () => {
      this.client.clear();
      this.client = this.factory();
      this.pending = null;
      this.doc = { ...EMPTY };
      this.cache = { version: 1, dashboard: null, time: 0 };
      this.clearCaches();
      this.vault.save('ecoledirecte', this.doc);
      this.vault.save('cache', this.cache);
    });
  }

  /** Reconnexion silencieuse avec les identifiants gardés ; `false` si une action humaine est nécessaire. */
  private async relogin(): Promise<boolean> {
    const { username, password, factors } = this.doc;
    if (!username || !password) {
      this.doc.attention = 'La session ÉcoleDirecte a expiré. Un parent doit se reconnecter.';
      this.persist();
      return false;
    }
    this.client.clear();
    this.client = this.factory();
    try {
      const result = await this.client.login(username, password, factors);
      if (result.state === 'authenticated') {
        if (this.client.trusted.length) this.doc.factors = this.client.trusted;
        this.doc.attention = null;
        this.persist();
        return true;
      }
      this.client.clear();
      this.doc.attention =
        result.state === 'totp'
          ? 'ÉcoleDirecte demande un code de vérification. Un parent doit se reconnecter.'
          : 'ÉcoleDirecte pose une question de sécurité. Un parent doit se reconnecter.';
    } catch (e) {
      this.doc.attention =
        e instanceof EdError && e.status === 400
          ? `Reconnexion refusée : ${e.message}`
          : 'ÉcoleDirecte est injoignable pour le moment.';
    }
    this.persist();
    return false;
  }

  /** Appel authentifié avec une reconnexion automatique et un seul nouvel essai si le jeton a expiré. */
  private async call<T>(run: (client: EdClient) => Promise<T>): Promise<T> {
    if (this.client.state !== 'authenticated' && !(await this.relogin()))
      throw new EdError(this.doc.attention || 'ÉcoleDirecte n’est pas connecté.', 503);
    try {
      const result = await run(this.client);
      this.persist();
      return result;
    } catch (e) {
      if (!(e instanceof EdError) || e.status !== 401) {
        this.persist();
        throw e;
      }
      if (!(await this.relogin())) throw new EdError(this.doc.attention || 'Reconnexion impossible.', 503);
      const result = await run(this.client);
      this.persist();
      return result;
    }
  }

  /**
   * Tableau de bord partagé. `maxAge` permet à un parent de forcer l'actualisation
   * (au plus une fois par minute). En cas d'échec, la dernière version connue est
   * renvoyée avec `stale: true` plutôt qu'une page vide.
   */
  dashboard(maxAge = DASHBOARD_TTL): Promise<{ dashboard: Dashboard | null; stale: boolean }> {
    return this.serial(async () => {
      if (this.cache.dashboard && Date.now() - this.cache.time < Math.max(maxAge, this.floor))
        return { dashboard: this.cache.dashboard, stale: false };
      if (!this.hasAccount) return { dashboard: this.cache.dashboard, stale: !!this.cache.dashboard };
      try {
        const fresh = await this.call((c) => c.dashboard());
        this.remember(fresh);
        this.cache = { version: 1, dashboard: fresh, time: Date.now() };
        this.doc.lastSync = fresh.updatedAt;
        this.vault.save('cache', this.cache);
        this.persist();
        return { dashboard: fresh, stale: false };
      } catch (e) {
        if (this.cache.dashboard) return { dashboard: this.cache.dashboard, stale: true };
        throw e;
      }
    });
  }

  private remember(dashboard: Dashboard): void {
    const first = Object.keys(this.history.firstSeen).length === 0;
    const now = Date.now();
    let changed = false;
    for (const child of dashboard.children)
      for (const note of child.notes) {
        const key = noteKey(child.id, note);
        if (!(key in this.history.firstSeen)) {
          this.history.firstSeen[key] = first ? 0 : now;
          changed = true;
        }
      }
    if (changed) this.vault.save('history', this.history);
  }

  firstSeen(key: string): number {
    return this.history.firstSeen[key] ?? 0;
  }

  homework(childId: string, cursor: number | null, maxAge = HOMEWORK_TTL): Promise<HomeworkPage> {
    return this.serial(async () => {
      const key = childId + ':' + String(cursor);
      const cached = this.homeworkCache.get(key);
      if (cached && Date.now() - cached.time < Math.max(maxAge, this.floor)) return cached.value;
      if (!this.cache.dashboard?.children.some((c) => c.id === childId)) throw new EdError('Élève introuvable.', 404);
      const value = await this.call((c) => c.homeworkForChild(childId, { cursor }));
      this.homeworkCache.set(key, { time: Date.now(), value });
      return value;
    });
  }

  /** Emploi du temps d'un jour pour un élève (cache 15 min). */
  timetable(childId: string, date: string, maxAge = 15 * 60000): Promise<Course[]> {
    return this.serial(async () => {
      const key = childId + ':' + date;
      const cached = this.timetableCache.get(key);
      if (cached && Date.now() - cached.time < Math.max(maxAge, this.floor)) return cached.value;
      if (!this.cache.dashboard?.children.some((c) => c.id === childId)) throw new EdError('Élève introuvable.', 404);
      const value = await this.call((c) => c.timetableForChild(childId, date, date));
      this.timetableCache.set(key, { time: Date.now(), value });
      if (this.timetableCache.size > 60) this.timetableCache.delete(this.timetableCache.keys().next().value as string);
      return value;
    });
  }

  /** Documents du compte famille (cache 30 min). */
  documents(maxAge = 30 * 60000): Promise<EdDocument[]> {
    return this.serial(async () => {
      if (this.docCache && Date.now() - this.docCache.time < Math.max(maxAge, this.floor)) return this.docCache.value;
      const value = await this.call((c) => c.documents());
      this.docCache = { time: Date.now(), value };
      return value;
    });
  }

  documentFile(id: string): Promise<EdFile> {
    return this.serial(() => this.call((c) => c.documentFile(id)));
  }

  /** Contenu des séances d'un jour passé (cache 30 min). */
  lessons(childId: string, date: string, maxAge = 30 * 60000): Promise<Lesson[]> {
    return this.serial(async () => {
      const key = childId + ':' + date;
      const cached = this.lessonCache.get(key);
      if (cached && Date.now() - cached.time < Math.max(maxAge, this.floor)) return cached.value;
      if (!this.cache.dashboard?.children.some((c) => c.id === childId)) throw new EdError('Élève introuvable.', 404);
      const value = await this.call((c) => c.lessonsForChild(childId, date));
      this.lessonCache.set(key, { time: Date.now(), value });
      if (this.lessonCache.size > 80) this.lessonCache.delete(this.lessonCache.keys().next().value as string);
      return value;
    });
  }

  /** Informations du collège (post-its), cache 1 h ; une erreur donne une liste vide. */
  schoolInfos(childId: string): Promise<SchoolInfo[]> {
    return this.serial(async () => {
      const cached = this.infoCache.get(childId);
      if (cached && Date.now() - cached.time < 3600000) return cached.value;
      try {
        const value = await this.call((c) => c.schoolInfosForChild(childId));
        this.infoCache.set(childId, { time: Date.now(), value });
        return value;
      } catch {
        return [];
      }
    });
  }

  private knownChild(childId: string): void {
    if (!this.cache.dashboard?.children.some((c) => c.id === childId)) throw new EdError('Élève introuvable.', 404);
  }

  /**
   * Messages reçus d'une boîte (`null` = messagerie famille), cache 5 min.
   * `maxAge = 0` force la relecture (au plus une fois par minute).
   */
  mailbox(childId: string | null, maxAge = 5 * 60000): Promise<EdMail[]> {
    return this.serial(async () => {
      const key = childId === null ? 'famille' : 'eleve:' + childId;
      const cached = this.mailCache.get(key);
      if (cached && Date.now() - cached.time < Math.max(maxAge, this.floor)) return cached.value;
      if (childId !== null) this.knownChild(childId);
      const value = await this.call((c) => c.mailbox(childId));
      this.mailCache.set(key, { time: Date.now(), value });
      return value;
    });
  }

  /** Message complet, gardé 30 min en mémoire (50 au plus). */
  mail(childId: string | null, id: string): Promise<EdMailDetail> {
    return this.serial(async () => {
      const key = (childId === null ? 'famille' : 'eleve:' + childId) + '/' + id;
      const cached = this.mailDetails.get(key);
      if (cached && Date.now() - cached.time < 30 * 60000) return cached.value;
      if (childId !== null) this.knownChild(childId);
      const value = await this.call((c) => c.mail(childId, id));
      this.mailDetails.set(key, { time: Date.now(), value });
      if (this.mailDetails.size > 50) this.mailDetails.delete(this.mailDetails.keys().next().value as string);
      return value;
    });
  }

  /** Pièce jointe, jamais gardée par Orbite. */
  mailFile(fileId: string): Promise<EdFile> {
    return this.serial(() => this.call((c) => c.mailFile(fileId)));
  }

  /** Vie scolaire d'un élève, cache 15 min. */
  schoolLife(childId: string, maxAge = 15 * 60000): Promise<SchoolLife> {
    return this.serial(async () => {
      const cached = this.lifeCache.get(childId);
      if (cached && Date.now() - cached.time < Math.max(maxAge, this.floor)) return cached.value;
      this.knownChild(childId);
      const value = await this.call((c) => c.schoolLifeForChild(childId));
      this.lifeCache.set(childId, { time: Date.now(), value });
      return value;
    });
  }

  /** Rafraîchissement de fond : garde la session active et l'historique à jour (6 h – 22 h). */
  startBackground(intervalMs = 30 * 60000): NodeJS.Timeout {
    const timer = setInterval(() => {
      const hour = parisHour(new Date());
      if (hour < 6 || hour >= 22 || !this.hasAccount || this.doc.attention) return;
      if (Date.now() - this.cache.time < 2 * 3600000) return;
      this.dashboard(0).catch(() => undefined);
    }, intervalMs);
    timer.unref();
    return timer;
  }
}

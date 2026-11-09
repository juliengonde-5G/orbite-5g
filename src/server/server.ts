/**
 * Serveur HTTP d'Orbite 5G.
 *
 * Rôle : sert l'application installable (fichiers statiques sur liste blanche) et
 * l'API JSON `/api/*`. Trois couches :
 * - `Family` : profils, PIN, appareils connectés, droits ;
 * - `EdService` : la connexion ÉcoleDirecte unique du compte parent ;
 * - `Coach` : conseils IA optionnels.
 *
 * Droits :
 * - un enfant ne reçoit que les données de l'élève rattaché à son profil ;
 * - un parent voit tous les élèves ; un parent administrateur gère en plus la
 *   connexion ÉcoleDirecte et les profils ;
 * - l'installation (premier PIN administrateur) n'est acceptée que depuis le
 *   réseau de la maison, jamais au travers du reverse proxy.
 *
 * Sécurité : hôtes autorisés, Origin contrôlée, en-tête `X-Orbite-Client` et JSON
 * obligatoires sur les POST (CSRF), corps limité à 16 Kio, cookie HttpOnly
 * SameSite=Strict (Secure en HTTPS), limitation des essais de PIN, CSP stricte.
 * Aucun secret n'est renvoyé au navigateur.
 */
import http from 'node:http';
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { ClaudeCoach, type Coach } from './coach.ts';
import { EdError } from './ecoledirecte.ts';
import { EdService, type EdClient } from './ed-service.ts';
import { Family, FamilyError, type MemberRecord } from './family.ts';
import { Vault } from './vault.ts';
import { DemoEd } from './demo.ts';
import { Notifier } from './notifier.ts';
import { noteKey, parisDate } from '../shared/metrics.ts';
import type {
  BagDay,
  ClaudeKeyStatus,
  Dashboard,
  FamilyDashboard,
  Kit,
  MailDetail,
  MailItem,
  MailList,
  SessionInfo,
} from '../shared/types.ts';
import type { EdMail } from './ecoledirecte.ts';
import { bagDate, bagItems, emptyKit } from '../shared/bag.ts';

const projectRoot = new URL('../../', import.meta.url);
const rootPath = fileURLToPath(projectRoot);

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

interface Asset {
  file: string;
  type: string;
  etag: string;
  body: Buffer;
  immutable: boolean;
}

/**
 * Liste blanche construite au démarrage à partir de `public/` et des sorties
 * compilées destinées au navigateur. Aucun chemin de requête n'est jamais
 * résolu sur le disque : seules ces entrées existent.
 */
function loadAssets(): Map<string, Asset> {
  const map = new Map<string, Asset>();
  const add = (url: string, file: string) => {
    const type = TYPES[extname(file)];
    if (!type) return;
    const body = readFileSync(file);
    map.set(url, {
      file,
      type,
      body,
      etag: '"' + createHash('sha256').update(body).digest('base64url').slice(0, 22) + '"',
      immutable: url.startsWith('/fonts/'),
    });
  };
  const walk = (dir: string, prefix: string) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, prefix + e.name + '/');
      else add(prefix + e.name, full);
    }
  };
  walk(join(rootPath, 'public'), '/');
  walk(join(rootPath, 'dist', 'client'), '/client/');
  walk(join(rootPath, 'dist', 'shared'), '/shared/');
  try {
    add('/style.css', join(rootPath, 'dist', 'style.css'));
  } catch {}
  const index = map.get('/index.html');
  if (index) map.set('/', index);
  return map;
}

/** Adresse IP privée ou locale (IPv4, IPv6, IPv4 mappée en IPv6). */
export function isPrivateAddress(address: string | undefined): boolean {
  if (!address) return false;
  const ip = address.replace(/^::ffff:/i, '');
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const v6 = ip.toLowerCase();
  return v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80:');
}

interface RequestData {
  [key: string]: unknown;
}

interface Context {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  data: RequestData;
  me: MemberRecord | undefined;
  token: string | undefined;
  onLan: boolean;
  secure: boolean;
}

class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface AppOptions {
  vault: Vault;
  familySeed?: string;
  publicUrl?: string;
  allowedHosts?: string[];
  edFactory?: () => EdClient;
  coach?: Coach;
  version?: string;
  background?: boolean;
  /** Âge minimal du cache ÉcoleDirecte en ms (60 s par défaut ; réduit dans les tests). */
  refreshFloor?: number;
  /** Notificateur imposé (tests). */
  notifier?: Notifier;
}

interface SeenDoc {
  version: 1;
  seenAt: Record<string, number>;
}

interface ChecksDoc {
  version: 1;
  /** Élève → identifiant de devoir → profil qui l'a coché. */
  done: Record<string, Record<string, string>>;
}

interface BagDoc {
  version: 1;
  /** Élève → jour → objets cochés « dans le sac ». */
  packed: Record<string, Record<string, string[]>>;
  kits: Record<string, Kit>;
}

interface ClaudeDoc {
  version: 1;
  /** Clé API saisie par le parent administrateur ; `null` = variable d'environnement. */
  key: string | null;
  updatedAt: string | null;
  check: ClaudeKeyStatus['check'];
}

/** « sk-ant-…a1B2 » : assez pour reconnaître la clé, jamais assez pour s'en servir. */
const maskKey = (key: string) => (key.length > 14 ? `${key.slice(0, 7)}…${key.slice(-4)}` : '••••');

interface MailDoc {
  version: 1;
  /** Message famille (`f.<id>`) → élèves avec qui un parent l'a partagé. */
  shares: Record<string, string[]>;
  /** Par membre : début du suivi (ms) et messages ouverts dans Orbite (clé → ms). */
  readers: Record<string, { since: number; opened: Record<string, number> }>;
}

type MailRef =
  | { box: 'family'; childId: null; id: string; key: string }
  | { box: 'student'; childId: string; id: string; key: string };

/** `f.<id>` (messagerie famille) ou `s.<élève>.<id>` (messagerie d'un élève). */
function parseMailKey(value: unknown): MailRef {
  const key = typeof value === 'string' ? value : '';
  const family = /^f\.(\d{1,12})$/.exec(key);
  if (family?.[1]) return { box: 'family', childId: null, id: family[1], key };
  const student = /^s\.([\w:-]{1,60})\.(\d{1,12})$/.exec(key);
  if (student?.[1] && student[2]) return { box: 'student', childId: student[1], id: student[2], key };
  throw new HttpError('Message introuvable.', 404);
}

/** Types de pièces jointes servis tels quels ; les autres sont proposés au téléchargement. */
const INLINE_TYPES = /^(application\/pdf|image\/(png|jpeg|gif|webp))$/;
const SAFE_TYPES =
  /^(application\/pdf|image\/(png|jpeg|gif|webp)|text\/plain|audio\/mpeg|video\/mp4|application\/(msword|zip|vnd\.ms-excel|vnd\.ms-powerpoint|vnd\.openxmlformats-officedocument\.[\w.]+|vnd\.oasis\.opendocument\.[\w.]+))$/;

/** Liste de textes courts saisie par la famille (matériel). */
function cleanList(value: unknown, max = 20): string[] {
  if (!Array.isArray(value)) throw new HttpError('Liste de matériel invalide.', 400);
  const list = value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim().slice(0, 60))
    .filter(Boolean);
  return [...new Set(list)].slice(0, max);
}

interface SecretDoc {
  version: 1;
  secret: string;
  /** Code d'installation à usage unique, valable tant que l'administrateur n'a pas choisi son PIN. */
  setupCode?: string;
}

const SETUP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const normalizeCode = (value: unknown) =>
  typeof value === 'string' ? value.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';

export function createApp(options: AppOptions): http.Server {
  const { vault } = options;
  const family = new Family(vault, options.familySeed ?? '');
  const ed = new EdService(vault, options.edFactory, options.refreshFloor);
  const coach = options.coach ?? new ClaudeCoach();
  const claude = vault.load<ClaudeDoc>('claude', { version: 1, key: null, updatedAt: null, check: null });
  if (claude.key) coach.setKey(claude.key);
  const envKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  const claudeStatus = (): ClaudeKeyStatus => {
    const key = claude.key || envKey;
    return {
      configured: coach.configured,
      source: claude.key ? 'app' : envKey ? 'env' : null,
      masked: key ? maskKey(key) : null,
      updatedAt: claude.key ? claude.updatedAt : null,
      check: claude.key ? claude.check : null,
    };
  };
  const assets = loadAssets();
  const version = options.version ?? '1.0.0';
  const publicHost = (() => {
    try {
      return options.publicUrl ? new URL(options.publicUrl).host.toLowerCase() : '';
    } catch {
      return '';
    }
  })();
  const extraHosts = new Set((options.allowedHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean));
  const seen = vault.load<SeenDoc>('seen', { version: 1, seenAt: {} });
  const checks = vault.load<ChecksDoc>('checks', { version: 1, done: {} });
  const bag = vault.load<BagDoc>('bag', { version: 1, packed: {}, kits: {} });
  const mail = vault.load<MailDoc>('mail', { version: 1, shares: {}, readers: {} });
  const validDay = (value: unknown): string => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError('Date invalide.', 400);
    const diff = (Date.parse(value + 'T12:00:00Z') - Date.parse(parisDate(new Date()) + 'T12:00:00Z')) / 86400000;
    if (!(diff >= -1 && diff <= 14)) throw new HttpError('Date hors de la période proposée.', 400);
    return value;
  };
  const pruneBag = () => {
    const limit = new Date(parisDate(new Date()) + 'T12:00:00Z');
    limit.setUTCDate(limit.getUTCDate() - 7);
    const cut = limit.toISOString().slice(0, 10);
    for (const days of Object.values(bag.packed)) for (const d of Object.keys(days)) if (d < cut) delete days[d];
  };
  const secretDoc = vault.load<SecretDoc>('secret', { version: 1, secret: '' });
  if (!secretDoc.secret) {
    secretDoc.secret = randomBytes(32).toString('hex');
    vault.save('secret', secretDoc);
  }
  // Installation à distance : le code s'affiche dans le journal du conteneur, que
  // seul un administrateur du NAS peut lire. Depuis la maison, il n'est pas demandé.
  if (family.setupNeeded && !secretDoc.setupCode) {
    secretDoc.setupCode = Array.from({ length: 8 }, () => SETUP_ALPHABET[randomInt(SETUP_ALPHABET.length)]).join('');
    vault.save('secret', secretDoc);
  }
  if (family.setupNeeded && options.background && secretDoc.setupCode)
    console.log(
      `Code d’installation (parent administrateur) : ${secretDoc.setupCode.slice(0, 4)}-${secretDoc.setupCode.slice(4)}`,
    );
  const background = options.background ? ed.startBackground() : undefined;
  const pushSubject = (() => {
    const contact = (process.env.ORBITE_PUSH_CONTACT || '').trim();
    if (/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) return contact;
    try {
      const url = options.publicUrl ? new URL(options.publicUrl) : null;
      if (url?.protocol === 'https:') return url.origin;
    } catch {
      // adresse publique invalide : contact par défaut
    }
    return 'mailto:orbite@example.com';
  })();
  const notifier = options.notifier ?? new Notifier({ vault, family, ed, subject: pushSubject });
  const pushTimer = options.background ? notifier.start() : undefined;
  const loginAttempts: number[] = [];

  // Appareil déjà utilisé par la famille : cookie signé, sans valeur secrète, qui
  // autorise l'affichage des prénoms sur l'écran de verrouillage hors de la maison.
  const sign = (value: string) => createHmac('sha256', secretDoc.secret).update(value).digest('hex').slice(0, 32);
  const knownDevice = (cookie: string): boolean => {
    const m = /(?:^|; )o5g_known=([a-f0-9]{32})\.([a-f0-9]{32})(?:;|$)/.exec(cookie);
    if (!m?.[1] || !m[2]) return false;
    const expected = Buffer.from(sign(m[1]));
    const given = Buffer.from(m[2]);
    return expected.length === given.length && timingSafeEqual(expected, given);
  };

  const hostAllowed = (host: string): boolean => {
    const h = host.toLowerCase();
    if (!h) return false;
    if (h === publicHost || extraHosts.has(h)) return true;
    const name = h.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    // Noms locaux (« monnas », « monnas.local ») et adresses IP : réseau de la maison.
    return name === 'localhost' || !name.includes('.') || name.endsWith('.local') || isIP(name) !== 0;
  };

  const onLan = (req: http.IncomingMessage): boolean => {
    const forwarded = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers.forwarded;
    const host = (req.headers.host || '').toLowerCase();
    return !forwarded && host !== publicHost && isPrivateAddress(req.socket.remoteAddress);
  };

  const setCookies = (ctx: Context, token: string | null) => {
    const secure = ctx.secure ? '; Secure' : '';
    const cookies = [
      token
        ? `o5g=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=15552000${secure}`
        : `o5g=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,
    ];
    if (token) {
      const id = randomBytes(16).toString('hex');
      cookies.push(`o5g_known=${id}.${sign(id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=34560000${secure}`);
    }
    ctx.res.setHeader('Set-Cookie', cookies);
  };

  const requireMember = (ctx: Context): MemberRecord => {
    if (!ctx.me) throw new HttpError('Déverrouille Orbite pour continuer.', 401);
    return ctx.me;
  };
  const requireParent = (ctx: Context): MemberRecord => {
    const me = requireMember(ctx);
    if (me.role !== 'parent') throw new HttpError('Réservé aux parents.', 403);
    return me;
  };
  const requireAdmin = (ctx: Context): MemberRecord => {
    const me = requireMember(ctx);
    if (!me.admin) throw new HttpError('Réservé au parent administrateur.', 403);
    return me;
  };

  /** Élèves visibles par un membre : tous pour un parent, le sien seulement pour un enfant. */
  const visibleIds = (me: MemberRecord, dashboard: Dashboard | null): string[] => {
    const ids = (dashboard?.children ?? []).map((c) => c.id);
    if (me.role === 'parent') return ids;
    return me.studentId && ids.includes(me.studentId) ? [me.studentId] : [];
  };

  const canSee = async (me: MemberRecord, childId: unknown): Promise<string> => {
    if (typeof childId !== 'string') throw new HttpError('Élève introuvable.', 404);
    if (me.role === 'child') {
      if (me.studentId !== childId) throw new HttpError('Élève introuvable.', 404);
      return childId;
    }
    const { dashboard } = await ed.dashboard();
    if (!dashboard?.children.some((c) => c.id === childId)) throw new HttpError('Élève introuvable.', 404);
    return childId;
  };

  /** Droit de lire un message : parents toujours ; élève, sa propre boîte ou ce qu'un parent lui a partagé. */
  const mailAllowed = async (me: MemberRecord, ref: MailRef): Promise<void> => {
    if (ref.box === 'student') await canSee(me, ref.childId);
    else if (me.role !== 'parent' && (!me.studentId || !(mail.shares[ref.key] ?? []).includes(me.studentId)))
      throw new HttpError('Message introuvable.', 404);
    // Le compte parent ouvre toutes les boîtes : on vérifie donc que le message
    // figure bien dans celle que nomme la clé, plutôt que de s'en remettre à ÉcoleDirecte.
    await listedMail(ref);
  };

  /** Message présent dans la boîte nommée par la clé (liste relue une fois si besoin), sinon 404. */
  const listedMail = async (ref: MailRef): Promise<EdMail> => {
    const find = (list: EdMail[]) => list.find((m) => m.id === ref.id);
    const found = find(await ed.mailbox(ref.childId)) ?? find(await ed.mailbox(ref.childId, 0));
    if (!found) throw new HttpError('Message introuvable.', 404);
    return found;
  };

  const reader = (me: MemberRecord) => {
    mail.readers[me.id] ??= { since: Date.now() - 14 * 86400000, opened: {} };
    return mail.readers[me.id] as MailDoc['readers'][string];
  };

  /** Repères propres à Orbite : clé, nouveauté pour ce membre, partage (parents). */
  const mailItem = (me: MemberRecord, m: EdMail, ref: Omit<MailRef, 'id' | 'key'>): MailItem => {
    const key = ref.box === 'family' ? `f.${m.id}` : `s.${ref.childId}.${m.id}`;
    const r = reader(me);
    const time = Date.parse(m.date + ':00+01:00') || 0;
    // Un message famille partagé avec un enfant reste « lu » sur ÉcoleDirecte dès qu'un parent l'a ouvert : seul Orbite compte alors.
    const edRead = ref.box === 'family' && me.role === 'child' ? false : m.read;
    return {
      key,
      box: ref.box,
      childId: ref.childId,
      subject: m.subject,
      from: m.from,
      fromRole: m.fromRole,
      date: m.date,
      files: m.files.map(({ id, name }) => ({ id, name })),
      isNew: !r.opened[key] && !edRead && time >= r.since,
      ...(ref.box === 'family' && me.role === 'parent' ? { sharedWith: mail.shares[key] ?? [] } : {}),
    };
  };

  const pruneMail = () => {
    const cut = Date.now() - 120 * 86400000;
    for (const r of Object.values(mail.readers))
      for (const [k, t] of Object.entries(r.opened)) if (t < cut) delete r.opened[k];
  };

  /** Lien de téléchargement signé (15 min) : il fonctionne même ouvert hors de l'appli installée, sans cookie. */
  const fileLink = (me: MemberRecord, token: string | undefined, key: string, file: string): string => {
    const payload = Buffer.from(
      JSON.stringify({ k: key, f: file, m: me.id, d: family.deviceTag(token), e: Date.now() + 15 * 60000 }),
    ).toString('base64url');
    const sig = createHmac('sha256', secretDoc.secret)
      .update('file:' + payload)
      .digest('base64url');
    return `/api/message/file?t=${payload}.${sig}`;
  };

  const readFileLink = (token: string | null): { k: string; f: string; m: string; d: string } => {
    const [payload = '', sig = ''] = (token ?? '').split('.');
    // Contrôle de forme d'abord : une signature non ASCII ferait échouer la comparaison à temps constant.
    if (!/^[\w-]{1,1024}$/.test(payload) || !/^[\w-]{43}$/.test(sig))
      throw new HttpError('Lien de pièce jointe invalide.', 403);
    const expected = createHmac('sha256', secretDoc.secret)
      .update('file:' + payload)
      .digest('base64url');
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))
      throw new HttpError('Lien de pièce jointe invalide.', 403);
    let data: { k?: unknown; f?: unknown; m?: unknown; d?: unknown; e?: unknown };
    try {
      data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      throw new HttpError('Lien de pièce jointe invalide.', 403);
    }
    if (typeof data.e !== 'number' || data.e < Date.now())
      throw new HttpError('Lien expiré : rouvre le message dans Orbite.', 410);
    if (
      typeof data.k !== 'string' ||
      typeof data.f !== 'string' ||
      typeof data.m !== 'string' ||
      typeof data.d !== 'string'
    )
      throw new HttpError('Lien de pièce jointe invalide.', 403);
    // Lien lié à l'appareil : il cesse de fonctionner dès que ce profil est verrouillé ou déconnecté.
    if (!family.deviceActive(data.m, data.d)) throw new HttpError('Lien expiré : rouvre le message dans Orbite.', 410);
    return { k: data.k, f: data.f, m: data.m, d: data.d };
  };

  const findMember = (data: RequestData) => {
    if (typeof data.memberId === 'string') return family.member(data.memberId);
    if (typeof data.name === 'string') {
      const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
      const found = family.members.filter((m) => norm(m.name) === norm(data.name as string));
      if (found.length === 1 && found[0]) return found[0];
    }
    throw new FamilyError('Profil introuvable. Vérifie le prénom.', 404);
  };

  const throttle = () => {
    const now = Date.now();
    while (loginAttempts.length && (loginAttempts[0] ?? 0) < now - 60000) loginAttempts.shift();
    if (loginAttempts.length >= 20) throw new HttpError('Trop de tentatives. Attends une minute.', 429);
    loginAttempts.push(now);
  };

  const sessionInfo = (ctx: Context): SessionInfo => {
    const showMembers = ctx.onLan || !!ctx.me || knownDevice(ctx.req.headers.cookie || '');
    const now = Date.now();
    return {
      members: showMembers
        ? family.members.map((m) => {
            const v = family.view(m, now);
            return {
              id: v.id,
              name: v.name,
              role: v.role,
              admin: v.admin,
              color: v.color,
              hasPin: v.hasPin,
              activationPending: v.activationPending,
              lockedUntil: v.lockedUntil,
            };
          })
        : [],
      setupNeeded: family.setupNeeded,
      onLan: ctx.onLan,
      me: ctx.me ? family.view(ctx.me) : null,
      ed: ctx.me?.role === 'parent' ? ed.status() : null,
      coaching: coach.configured,
      version,
    };
  };

  const pruneChecks = () => {
    const limit = new Date(parisDate(new Date()) + 'T12:00:00Z');
    limit.setUTCDate(limit.getUTCDate() - 7);
    const cut = limit.toISOString().slice(0, 10);
    for (const [student, items] of Object.entries(checks.done)) {
      for (const id of Object.keys(items)) if (id.slice(0, 10) < cut) delete items[id];
      if (!Object.keys(items).length) delete checks.done[student];
    }
  };

  const routes = new Map<string, (ctx: Context) => Promise<unknown>>([
    [
      'POST /api/setup',
      async (ctx) => {
        throttle();
        const expected = secretDoc.setupCode ?? '';
        const given = normalizeCode(ctx.data.code);
        const codeOk =
          expected.length === 8 && given.length === 8 && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
        if (!ctx.onLan && !codeOk)
          throw new HttpError(
            'Code d’installation incorrect. Il figure dans le journal du conteneur « orbite » (Container Manager).',
            403,
          );
        const token = family.claimAdmin(findMember(ctx.data).id, ctx.data.pin);
        delete secretDoc.setupCode;
        vault.save('secret', secretDoc);
        setCookies(ctx, token);
        ctx.me = family.authenticate(token);
        return sessionInfo(ctx);
      },
    ],
    [
      'POST /api/login',
      async (ctx) => {
        throttle();
        const member = findMember(ctx.data);
        const token = family.login(member.id, ctx.data.pin);
        setCookies(ctx, token);
        ctx.me = family.authenticate(token);
        return sessionInfo(ctx);
      },
    ],
    [
      'POST /api/activate',
      async (ctx) => {
        throttle();
        const member = findMember(ctx.data);
        const token = family.activate(member.id, ctx.data.code, ctx.data.pin);
        setCookies(ctx, token);
        ctx.me = family.authenticate(token);
        return sessionInfo(ctx);
      },
    ],
    [
      'POST /api/logout',
      async (ctx) => {
        // L'appareil verrouillé ne reçoit plus les notifications de ce profil.
        if (ctx.me) notifier.unsubscribe(ctx.me, family.deviceTag(ctx.token));
        family.logout(ctx.token);
        setCookies(ctx, null);
        ctx.me = undefined;
        return sessionInfo(ctx);
      },
    ],
    [
      'POST /api/prefs',
      async (ctx) => {
        const me = requireMember(ctx);
        return family.view(family.setPrefs(me.id, ctx.data));
      },
    ],
    [
      'POST /api/data',
      async (ctx) => {
        const me = requireMember(ctx);
        const refresh = ctx.data.refresh === true && me.role === 'parent';
        const { dashboard, stale } = await ed.dashboard(refresh ? 0 : undefined);
        if (dashboard && family.autoLink(dashboard.children.map((c) => ({ id: c.id, name: c.name })))) {
          ctx.me = family.member(me.id);
        }
        const ids = visibleIds(ctx.me ?? me, dashboard);
        const children = (dashboard?.children ?? []).filter((c) => ids.includes(c.id));
        const since = seen.seenAt[me.id] ?? 0;
        const fresh: string[] = [];
        for (const c of children)
          for (const n of c.notes) {
            const key = noteKey(c.id, n);
            const first = ed.firstSeen(key);
            if (first > 0 && first > since) fresh.push(key);
          }
        pruneChecks();
        const result: FamilyDashboard = {
          demo: false,
          updatedAt: dashboard?.updatedAt ?? '',
          children,
          fresh,
          stale,
          checks: Object.fromEntries(ids.map((id) => [id, Object.keys(checks.done[id] ?? {})])),
        };
        return result;
      },
    ],
    [
      'POST /api/seen',
      async (ctx) => {
        const me = requireMember(ctx);
        seen.seenAt[me.id] = Date.now();
        vault.save('seen', seen);
        return { ok: true };
      },
    ],
    [
      'POST /api/homework',
      async (ctx) => {
        const me = requireMember(ctx);
        const childId = await canSee(me, ctx.data.childId);
        const cursor = ctx.data.cursor ?? null;
        if (cursor !== null && (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor < 0))
          throw new HttpError('Pagination invalide.', 400);
        const maxAge = ctx.data.refresh === true ? 0 : undefined;
        return ed.homework(childId, cursor as number | null, maxAge);
      },
    ],
    [
      'POST /api/check',
      async (ctx) => {
        const me = requireMember(ctx);
        const childId = await canSee(me, ctx.data.childId);
        const id = ctx.data.homeworkId;
        if (typeof id !== 'string' || !/^\d{4}-\d{2}-\d{2}:[\w-]{1,40}$/.test(id))
          throw new HttpError('Devoir invalide.', 400);
        checks.done[childId] ??= {};
        const items = checks.done[childId];
        if (ctx.data.done === true) items[id] = me.id;
        else delete items[id];
        pruneChecks();
        vault.save('checks', checks);
        return { checks: Object.keys(checks.done[childId] ?? {}) };
      },
    ],
    [
      'POST /api/bag',
      async (ctx) => {
        const me = requireMember(ctx);
        const childId = await canSee(me, ctx.data.childId);
        const auto = bagDate();
        const date = ctx.data.date === undefined || ctx.data.date === null ? auto.date : validDay(ctx.data.date);
        const kit = bag.kits[childId] ?? emptyKit();
        let timetableError: string | null = null;
        let homeworkError: string | null = null;
        let courses: BagDay['courses'] = [];
        let homework: BagDay['homework'] = [];
        try {
          courses = await ed.timetable(childId, date);
        } catch (e) {
          timetableError = e instanceof EdError ? e.message : 'Emploi du temps indisponible.';
        }
        try {
          homework = (await ed.homework(childId, null)).homework.filter((h) => h.dueDate === date);
        } catch (e) {
          homeworkError = e instanceof EdError ? e.message : 'Cahier de textes indisponible.';
        }
        const infos = (await ed.schoolInfos(childId)).filter(
          (i) => (!i.from || i.from <= date) && (!i.to || i.to >= date),
        );
        const result: BagDay = {
          date,
          focus: date === auto.date ? auto.focus : date === parisDate(new Date()) ? 'today' : 'next',
          courses,
          homework,
          infos,
          items: bagItems(courses, homework, kit),
          packed: bag.packed[childId]?.[date] ?? [],
          kit,
          timetableError,
          homeworkError,
        };
        return result;
      },
    ],
    [
      'POST /api/bag/pack',
      async (ctx) => {
        const me = requireMember(ctx);
        const childId = await canSee(me, ctx.data.childId);
        const date = validDay(ctx.data.date);
        const item = ctx.data.itemId;
        if (typeof item !== 'string' || !/^[a-z0-9-]{1,60}$/.test(item)) throw new HttpError('Objet invalide.', 400);
        bag.packed[childId] ??= {};
        const days = bag.packed[childId];
        const set = new Set(days[date] ?? []);
        if (ctx.data.packed === true) set.add(item);
        else set.delete(item);
        days[date] = [...set];
        pruneBag();
        vault.save('bag', bag);
        return { packed: days[date] };
      },
    ],
    [
      'POST /api/bag/kit',
      async (ctx) => {
        const me = requireMember(ctx);
        const childId = await canSee(me, ctx.data.childId);
        const input = ctx.data.kit as { always?: unknown; subjects?: unknown } | undefined;
        if (!input || typeof input !== 'object') throw new HttpError('Matériel invalide.', 400);
        const subjects: Record<string, string[]> = {};
        if (input.subjects && typeof input.subjects === 'object' && !Array.isArray(input.subjects)) {
          for (const [key, list] of Object.entries(input.subjects as Record<string, unknown>).slice(0, 40)) {
            if (!/^[A-Z0-9 ]{1,60}$/.test(key)) throw new HttpError('Matière invalide.', 400);
            subjects[key] = cleanList(list, 10);
          }
        }
        bag.kits[childId] = { always: cleanList(input.always ?? [], 15), subjects };
        vault.save('bag', bag);
        return bag.kits[childId];
      },
    ],
    [
      'POST /api/messages',
      async (ctx) => {
        const me = requireMember(ctx);
        const maxAge = ctx.data.refresh === true ? 0 : undefined;
        const scope = ctx.data.childId ?? (me.role === 'parent' ? null : me.studentId);
        let items: MailItem[] = [];
        let unavailable: string | null = null;
        if (scope === null) {
          requireParent(ctx);
          items = (await ed.mailbox(null, maxAge)).map((m) => mailItem(me, m, { box: 'family', childId: null }));
        } else {
          const childId = await canSee(me, scope);
          try {
            items = (await ed.mailbox(childId, maxAge)).map((m) => mailItem(me, m, { box: 'student', childId }));
          } catch (e) {
            if (!(e instanceof EdError) || e.status === 503) throw e;
            unavailable = 'La messagerie élève n’est pas accessible depuis le compte parent pour cet établissement.';
          }
          const shared = Object.entries(mail.shares).filter(([, ids]) => ids.includes(childId));
          if (shared.length) {
            try {
              const keys = new Set(shared.map(([k]) => k));
              const family = (await ed.mailbox(null)).filter((m) => keys.has(`f.${m.id}`));
              items.push(...family.map((m) => mailItem(me, m, { box: 'family', childId: null })));
            } catch {}
          }
        }
        items.sort((a, b) => b.date.localeCompare(a.date));
        vault.save('mail', mail);
        const result: MailList = { items, unavailable, unread: items.filter((i) => i.isNew).length };
        return result;
      },
    ],
    [
      'POST /api/message',
      async (ctx) => {
        const me = requireMember(ctx);
        const ref = parseMailKey(ctx.data.key);
        await mailAllowed(me, ref);
        const detail = await ed.mail(ref.childId, ref.id);
        const item = mailItem(me, detail, { box: ref.box, childId: ref.childId });
        reader(me).opened[ref.key] = Date.now();
        pruneMail();
        vault.save('mail', mail);
        const result: MailDetail = {
          ...item,
          key: ref.key,
          isNew: false,
          text: detail.text,
          files: detail.files.map((f) => ({ ...f, url: fileLink(me, ctx.token, ref.key, f.id) })),
        };
        return result;
      },
    ],
    [
      'POST /api/message/share',
      async (ctx) => {
        requireParent(ctx);
        const ref = parseMailKey(ctx.data.key);
        if (ref.box !== 'family') throw new HttpError('Seuls les messages famille se partagent.', 400);
        const input = ctx.data.childIds;
        if (!Array.isArray(input) || input.length > 12 || !input.every((v) => typeof v === 'string'))
          throw new HttpError('Élèves invalides.', 400);
        const { dashboard } = await ed.dashboard();
        if (!dashboard) throw new HttpError('ÉcoleDirecte ne répond pas : réessaie dans un instant.', 503);
        await listedMail(ref);
        const known = new Set(dashboard.children.map((c) => c.id));
        const ids = [...new Set(input as string[])].filter((id) => known.has(id));
        const before = new Set(mail.shares[ref.key] ?? []);
        if (ids.length) mail.shares[ref.key] = ids;
        else delete mail.shares[ref.key];
        vault.save('mail', mail);
        const added = ids.filter((id) => !before.has(id));
        if (added.length) {
          const found = await listedMail(ref).catch(() => null);
          void notifier.shared(added, found?.subject || 'Nouveau message').catch(() => undefined);
        }
        return { sharedWith: ids };
      },
    ],
    [
      'POST /api/lessons',
      async (ctx) => {
        const me = requireMember(ctx);
        const childId = await canSee(me, ctx.data.childId);
        const date = ctx.data.date;
        if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError('Date invalide.', 400);
        const ago = (Date.parse(parisDate(new Date()) + 'T12:00:00Z') - Date.parse(date + 'T12:00:00Z')) / 86400000;
        if (!(ago >= 0 && ago <= 31)) throw new HttpError('Date hors de la période proposée.', 400);
        return { date, lessons: await ed.lessons(childId, date) };
      },
    ],
    [
      'POST /api/schoollife',
      async (ctx) => {
        const me = requireMember(ctx);
        const childId = await canSee(me, ctx.data.childId);
        return ed.schoolLife(childId, ctx.data.refresh === true ? 0 : undefined);
      },
    ],
    [
      'POST /api/coaching',
      async (ctx) => {
        const me = requireMember(ctx);
        const childId = await canSee(me, ctx.data.childId);
        if (!coach.configured) throw new HttpError('Conseils non configurés.', 503);
        const { dashboard } = await ed.dashboard();
        const child = dashboard?.children.find((c) => c.id === childId);
        if (!child) throw new HttpError('Élève introuvable.', 404);
        try {
          return { text: await coach.advice(childId, child) };
        } catch (e) {
          throw new HttpError((e as Error).message || 'Conseil indisponible.', 503);
        }
      },
    ],
    ['GET /api/push', async (ctx) => notifier.status(requireMember(ctx), family.deviceTag(ctx.token))],
    [
      'POST /api/push/subscribe',
      async (ctx) => {
        const me = requireMember(ctx);
        const tag = family.deviceTag(ctx.token);
        if (!notifier.subscribe(me, tag, ctx.data.subscription))
          throw new HttpError('Abonnement refusé : ce navigateur n’est pas reconnu.', 400);
        return notifier.status(me, tag);
      },
    ],
    [
      'POST /api/push/unsubscribe',
      async (ctx) => {
        const me = requireMember(ctx);
        const tag = family.deviceTag(ctx.token);
        notifier.unsubscribe(me, tag);
        return notifier.status(me, tag);
      },
    ],
    [
      'POST /api/push/prefs',
      async (ctx) => {
        const me = requireMember(ctx);
        notifier.setPrefs(me, ctx.data.prefs);
        return notifier.status(me, family.deviceTag(ctx.token));
      },
    ],
    [
      'POST /api/push/test',
      async (ctx) => {
        const me = requireMember(ctx);
        const sent = await notifier.notify(
          [me],
          { title: 'Orbite', body: 'Les notifications fonctionnent sur cet appareil.', url: '/#moi', tag: 'test' },
          null,
        );
        if (!sent) throw new HttpError('Aucun appareil n’a reçu la notification. Réactive-les sur cet appareil.', 503);
        return { sent };
      },
    ],
    [
      'GET /api/admin/members',
      async (ctx) => {
        requireParent(ctx);
        return { members: family.members.map((m) => family.view(m)), ed: ed.status() };
      },
    ],
    [
      'GET /api/admin/claude',
      async (ctx) => {
        requireAdmin(ctx);
        return claudeStatus();
      },
    ],
    [
      'POST /api/admin/claude',
      async (ctx) => {
        requireAdmin(ctx);
        const key = typeof ctx.data.key === 'string' ? ctx.data.key.trim() : '';
        if (!/^sk-ant-[\w-]{20,280}$/.test(key))
          throw new HttpError('Clé invalide : elle commence par « sk-ant- » (console.anthropic.com → API Keys).', 400);
        const check = await coach.check(key);
        if (check === 'refused')
          throw new HttpError('Anthropic refuse cette clé. Vérifie-la ou crée-en une nouvelle.', 400);
        claude.key = key;
        claude.updatedAt = new Date().toISOString();
        claude.check = check;
        vault.save('claude', claude);
        coach.setKey(key);
        return claudeStatus();
      },
    ],
    [
      'POST /api/admin/claude/remove',
      async (ctx) => {
        requireAdmin(ctx);
        Object.assign(claude, { key: null, updatedAt: null, check: null });
        vault.save('claude', claude);
        coach.setKey(null);
        return claudeStatus();
      },
    ],
    [
      'POST /api/admin/ed/connect',
      async (ctx) => {
        requireAdmin(ctx);
        return ed.connect(ctx.data.username, ctx.data.password, ctx.data.remember);
      },
    ],
    [
      'POST /api/admin/ed/verify',
      async (ctx) => {
        requireAdmin(ctx);
        return ed.verify({ choice: ctx.data.choice, code: ctx.data.code });
      },
    ],
    [
      'POST /api/admin/ed/disconnect',
      async (ctx) => {
        requireAdmin(ctx);
        await ed.disconnect();
        return ed.status();
      },
    ],
    [
      'POST /api/admin/member/add',
      async (ctx) => {
        requireAdmin(ctx);
        return family.view(family.add(ctx.data));
      },
    ],
    [
      'POST /api/admin/member/update',
      async (ctx) => {
        requireAdmin(ctx);
        const students = ed.status().students.map((s) => s.id);
        const { name, grade, color, studentId, admin } = ctx.data;
        return family.view(family.update(ctx.data.memberId, { name, grade, color, studentId, admin }, students));
      },
    ],
    [
      'POST /api/admin/member/remove',
      async (ctx) => {
        const me = requireAdmin(ctx);
        if (ctx.data.memberId === me.id) throw new HttpError('Tu ne peux pas supprimer ton propre profil.', 400);
        family.remove(ctx.data.memberId);
        if (typeof ctx.data.memberId === 'string') notifier.forget(ctx.data.memberId);
        return { ok: true };
      },
    ],
    [
      'POST /api/admin/member/code',
      async (ctx) => {
        requireAdmin(ctx);
        return family.issueActivation(ctx.data.memberId);
      },
    ],
    [
      'POST /api/admin/member/signout',
      async (ctx) => {
        requireAdmin(ctx);
        family.signOutEverywhere(ctx.data.memberId);
        return { ok: true };
      },
    ],
  ]);

  const baseHeaders = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://ecoledirecte.com https://*.ecoledirecte.com; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };

  const server = http.createServer(async (req, res) => {
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { ...baseHeaders, 'Cache-Control': 'no-store', 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    try {
      const host = req.headers.host || '';
      const path = new URL(req.url ?? '/', 'http://orbite.invalid').pathname;
      if (path === '/healthz') return json(200, { ok: true, version });
      // Requête relayée en HTTPS par le reverse proxy du NAS (adresse locale) : son nom
      // public est accepté même si ORBITE_PUBLIC_URL n'est pas encore renseignée.
      const viaLocalProxy =
        String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https' &&
        isPrivateAddress(req.socket.remoteAddress);
      if (!hostAllowed(host) && !viaLocalProxy) throw new HttpError('Hôte non autorisé.', 403);
      if (req.headers.origin) {
        let originHost = '';
        try {
          originHost = new URL(req.headers.origin).host.toLowerCase();
        } catch {}
        if (originHost !== host.toLowerCase()) throw new HttpError('Origine refusée.', 403);
      }
      // Requête d'un autre site : refusée pour l'API, mais une simple ouverture de
      // page (lien reçu par message, favori) doit afficher l'appli.
      if (req.headers['sec-fetch-site'] === 'cross-site' && path.startsWith('/api/'))
        throw new HttpError('Origine refusée.', 403);

      if (!path.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError('Méthode refusée.', 405);
        const asset = assets.get(path);
        if (!asset) throw new HttpError('Page introuvable.', 404);
        const headers: Record<string, string> = {
          ...baseHeaders,
          'Content-Type': asset.type,
          ETag: asset.etag,
          'Cache-Control': asset.immutable ? 'public, max-age=2592000' : 'no-cache',
        };
        if (path === '/sw.js') headers['Service-Worker-Allowed'] = '/';
        if (req.headers['if-none-match'] === asset.etag) {
          res.writeHead(304, headers);
          res.end();
          return;
        }
        res.writeHead(200, headers);
        res.end(req.method === 'HEAD' ? undefined : asset.body);
        return;
      }

      const cookie = req.headers.cookie || '';
      const token = /(?:^|; )o5g=([a-f0-9]{64})(?:;|$)/.exec(cookie)?.[1];
      const forwardedProto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
      const ctx: Context = {
        req,
        res,
        data: {},
        me: family.authenticate(token),
        token,
        onLan: onLan(req),
        secure: forwardedProto === 'https' || (!!publicHost && host.toLowerCase() === publicHost),
      };

      if (req.method === 'GET' && path === '/api/session') return json(200, sessionInfo(ctx));
      if (req.method === 'GET' && path === '/api/message/file') {
        const link = readFileLink(new URL(req.url ?? '/', 'http://orbite.invalid').searchParams.get('t'));
        const member = family.members.find((m) => m.id === link.m);
        if (!member) throw new HttpError('Lien de pièce jointe invalide.', 403);
        const ref = parseMailKey(link.k);
        await mailAllowed(member, ref);
        const listed = (await ed.mail(ref.childId, ref.id)).files.find((f) => f.id === link.f);
        if (!listed) throw new HttpError('Pièce jointe introuvable.', 404);
        const file = await ed.mailFile(link.f);
        const type = SAFE_TYPES.test(file.type) ? file.type : 'application/octet-stream';
        const name = (file.name !== 'piece-jointe' ? file.name : listed.name).replace(/[\p{Cc}"\\]/gu, '');
        const ascii = name.normalize('NFD').replace(/[^\x20-\x7e]/g, '') || 'piece-jointe';
        const encoded = encodeURIComponent(name).replace(
          /['()*]/g,
          (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
        );
        res.writeHead(200, {
          ...baseHeaders,
          // Le lecteur PDF des navigateurs refuse un document « sandbox » : seuls les autres types le sont.
          'Content-Security-Policy':
            type === 'application/pdf'
              ? "frame-ancestors 'none'"
              : "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
          'Content-Type': type,
          'Content-Length': String(file.body.length),
          'Cache-Control': 'private, no-store',
          'Content-Disposition': `${INLINE_TYPES.test(type) ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`,
        });
        res.end(file.body);
        return;
      }
      const route = routes.get(`${req.method} ${path}`);
      if (req.method === 'POST') {
        if (req.headers['x-orbite-client'] !== '1' || !req.headers['content-type']?.startsWith('application/json'))
          throw new HttpError('Requête refusée.', 403);
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 16384) throw new HttpError('Requête trop volumineuse.', 413);
        }
        try {
          ctx.data = JSON.parse(body || '{}') as RequestData;
        } catch {
          throw new HttpError('JSON invalide.', 400);
        }
        if (!ctx.data || typeof ctx.data !== 'object' || Array.isArray(ctx.data))
          throw new HttpError('Données invalides.', 400);
      } else if (req.method !== 'GET') throw new HttpError('Méthode refusée.', 405);
      if (!route) throw new HttpError('Route introuvable.', 404);
      json(200, await route(ctx));
    } catch (error) {
      const known = error instanceof HttpError || error instanceof FamilyError || error instanceof EdError;
      if (!known) console.error('Erreur interne :', (error as Error)?.message);
      json((error as { status?: number })?.status || 500, {
        error: known ? (error as Error).message : 'Erreur inattendue du serveur.',
      });
    }
  });

  server.on('close', () => {
    if (background) clearInterval(background);
    if (pushTimer) clearInterval(pushTimer);
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.loadEnvFile(join(rootPath, '.env'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('Impossible de lire la configuration .env.');
      process.exit(1);
    }
  }
  const port = Number(process.env.PORT || 3210);
  const hostname = process.env.HOST || '0.0.0.0';
  let vault: Vault;
  try {
    vault = new Vault(process.env.ORBITE_DATA_DIR || join(rootPath, '.orbite-data'));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  let version = '1.0.0';
  try {
    version = (JSON.parse(readFileSync(join(rootPath, 'package.json'), 'utf8')) as { version: string }).version;
  } catch {}
  const server = createApp({
    vault,
    familySeed: process.env.ORBITE_FAMILY || '',
    publicUrl: process.env.ORBITE_PUBLIC_URL || '',
    allowedHosts: (process.env.ORBITE_ALLOWED_HOSTS || '').split(','),
    version,
    background: true,
    ...(process.env.ORBITE_DEMO === '1' ? { edFactory: () => new DemoEd() } : {}),
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  server.listen(port, hostname, () => {
    console.log(`Orbite 5G ${version} · écoute ${hostname}:${port}`);
    console.log(`Données chiffrées : ${relative(rootPath, vault.directory) || vault.directory}`);
  });
}

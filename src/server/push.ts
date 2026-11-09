/**
 * Notifications Web Push, sans dépendance.
 *
 * Rôle : envoyer un message chiffré à un navigateur abonné (PWA installée sur
 * un téléphone) via le service push de son éditeur (Google, Mozilla, Apple,
 * Microsoft). Seuls `node:crypto` et `fetch` sont utilisés.
 *
 * Fonctionnement :
 * - Identification du serveur (VAPID, RFC 8292) : une paire de clés P-256
 *   générée une fois (`generateVapidKeys`) ; chaque envoi porte un jeton JWT
 *   ES256 signé (`vapidAuthorization`) valable 12 h pour l'origine du service.
 * - Chiffrement du contenu (RFC 8291 + RFC 8188, codage `aes128gcm`) :
 *   clé éphémère serveur, ECDH avec la clé `p256dh` du navigateur, dérivations
 *   HKDF-SHA-256 avec le secret `auth`, puis AES-128-GCM en un seul
 *   enregistrement (rs = 4096, délimiteur de remplissage 0x02).
 *
 *   Corps envoyé : sel (16) | rs (4, gros-boutiste) | idlen (1) = 65 |
 *                  clé publique éphémère (65) | texte chiffré + tag GCM (16)
 *
 * - Envoi (`sendPush`) : POST vers l'endpoint, résultat simplifié
 *   `sent` / `gone` (abonnement expiré, à supprimer) / `failed`. Ne lève jamais.
 *
 * Points d'attention :
 * - `validSubscription` n'accepte que des endpoints https de services push
 *   connus : sans cette liste blanche, un abonnement forgé ferait de
 *   l'appli un relais de requêtes vers n'importe quelle adresse (SSRF).
 * - `crypto.hkdfSync` enchaîne extract + expand : c'est exactement le HKDF
 *   des RFC 8291/8188 (vérifié par le vecteur de test de la RFC 8291, annexe A).
 * - Les services push limitent le corps à 4096 octets : au-delà de 3993 octets
 *   de JSON, l'envoi est refusé localement (`failed`).
 */
import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
} from 'node:crypto';

/** Clés VAPID en base64url : clé publique P-256 non compressée (65 octets) et scalaire privé d (32 octets). */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** Abonnement tel que renvoyé par `PushSubscription.toJSON()` côté navigateur. */
export interface PushSubscriptionJSON {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Clé éphémère du serveur imposée (tests) : octets bruts. */
export interface ServerKeyPair {
  /** Clé publique non compressée (65 octets, 0x04 | x | y). */
  publicKey: Uint8Array;
  /** Scalaire privé d (32 octets). */
  privateKey: Uint8Array;
}

export interface EncryptOptions {
  /** Sel de 16 octets (aléatoire par défaut). */
  salt?: Uint8Array;
  /** Clé éphémère du serveur (générée à chaque appel par défaut). */
  serverKeys?: ServerKeyPair;
}

export type PushResult = 'sent' | 'gone' | 'failed';

/** Taille d'enregistrement annoncée dans l'en-tête aes128gcm. */
const RECORD_SIZE = 4096;
/** Taille maximale du corps acceptée par les services push. */
const MAX_BODY = 4096;
/** En-tête aes128gcm : sel (16) + rs (4) + idlen (1) + clé publique (65). */
const HEADER_LENGTH = 16 + 4 + 1 + 65;
const TAG_LENGTH = 16;
const SEND_TIMEOUT_MS = 15_000;
const DEFAULT_TTL = 24 * 3600;
const JWT_LIFETIME = 12 * 3600;
const MAX_ENDPOINT = 2048;

/** Hôtes exacts et suffixes (`*.domaine`) des services push reconnus. */
const PUSH_HOSTS = new Set(['fcm.googleapis.com', 'web.push.apple.com', 'updates.push.services.mozilla.com']);
const PUSH_HOST_SUFFIXES = ['.push.services.mozilla.com', '.notify.windows.com'];

const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

/** Décode du base64url strict (alphabet contrôlé, forme canonique) ; `null` si invalide. */
function fromBase64url(value: unknown): Buffer | null {
  if (typeof value !== 'string' || !BASE64URL.test(value)) return null;
  const bare = value.replace(/=+$/, '');
  const bytes = Buffer.from(bare, 'base64url');
  return bytes.toString('base64url') === bare ? bytes : null;
}

/** Vérifie qu'une clé publique brute est un point valide de la courbe P-256. */
function isP256Point(raw: Uint8Array): boolean {
  if (raw.length !== 65 || raw[0] !== 0x04) return false;
  try {
    createPublicKey({ key: rawToJwk(raw), format: 'jwk' });
    return true;
  } catch {
    return false;
  }
}

function rawToJwk(publicKey: Uint8Array, privateKey?: Uint8Array) {
  const raw = Buffer.from(publicKey);
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: raw.subarray(1, 33).toString('base64url'),
    y: raw.subarray(33, 65).toString('base64url'),
  };
  return privateKey ? { ...jwk, d: Buffer.from(privateKey).toString('base64url') } : jwk;
}

function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, length));
}

/** Génère une paire de clés VAPID (P-256) à conserver durablement côté serveur. */
export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  if (!jwk.x || !jwk.y || !jwk.d) throw new Error('Génération des clés VAPID impossible.');
  const publicKey = Buffer.concat([Buffer.of(0x04), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { publicKey: publicKey.toString('base64url'), privateKey: jwk.d };
}

/** Hôte d'un service push connu (liste blanche) ? */
function knownPushHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (PUSH_HOSTS.has(host)) return true;
  return PUSH_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}

/**
 * Contrôle strict d'un abonnement reçu du navigateur.
 * Renvoie une copie normalisée (sans champ superflu ni remplissage `=`), ou `null`.
 */
export function validSubscription(value: unknown): PushSubscriptionJSON | null {
  if (typeof value !== 'object' || value === null) return null;
  const { endpoint, keys } = value as { endpoint?: unknown; keys?: unknown };
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > MAX_ENDPOINT) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  if (!knownPushHost(url.hostname)) return null;
  if (typeof keys !== 'object' || keys === null) return null;
  const { p256dh, auth } = keys as { p256dh?: unknown; auth?: unknown };
  const publicKey = fromBase64url(p256dh);
  const secret = fromBase64url(auth);
  if (!publicKey || !isP256Point(publicKey)) return null;
  if (secret?.length !== 16) return null;
  return { endpoint, keys: { p256dh: publicKey.toString('base64url'), auth: secret.toString('base64url') } };
}

/**
 * Chiffre un message pour un abonnement (RFC 8291, codage aes128gcm, un seul enregistrement).
 * `opts` permet d'imposer sel et clé éphémère (vecteurs de test) ; sinon tout est aléatoire.
 */
export function encryptPayload(
  payload: Uint8Array,
  sub: PushSubscriptionJSON,
  opts: EncryptOptions = {},
): Uint8Array<ArrayBuffer> {
  const uaPublic = fromBase64url(sub.keys.p256dh);
  const authSecret = fromBase64url(sub.keys.auth);
  if (uaPublic?.length !== 65 || uaPublic[0] !== 0x04) throw new Error('Clé p256dh invalide.');
  if (authSecret?.length !== 16) throw new Error('Secret auth invalide.');
  if (payload.length + 1 + TAG_LENGTH > RECORD_SIZE) throw new Error('Message trop long pour un enregistrement.');

  const salt = opts.salt ?? randomBytes(16);
  if (salt.length !== 16) throw new Error('Le sel doit faire 16 octets.');

  const ecdh = createECDH('prime256v1');
  if (opts.serverKeys) {
    ecdh.setPrivateKey(opts.serverKeys.privateKey);
    if (!ecdh.getPublicKey().equals(opts.serverKeys.publicKey))
      throw new Error('Clé publique éphémère incohérente avec la clé privée.');
  } else {
    ecdh.generateKeys();
  }
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);

  // RFC 8291 §3.4 : IKM = HKDF(auth, secret ECDH, "WebPush: info\0" | ua_public | as_public, 32)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);
  // RFC 8188 §2.2 et §2.3 : clé de contenu et nonce (séquence 0, un seul enregistrement).
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.update(Buffer.of(0x02)), cipher.final()]);

  const header = Buffer.alloc(HEADER_LENGTH);
  Buffer.from(salt).copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  asPublic.copy(header, 21);
  return Buffer.concat([header, ciphertext, cipher.getAuthTag()]);
}

/**
 * En-tête `Authorization` VAPID (RFC 8292) pour un endpoint :
 * `vapid t=<JWT ES256>, k=<clé publique base64url>`.
 * `now` en millisecondes (horloge courante par défaut).
 */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): string {
  if (!/^(mailto:|https:)/.test(subject)) throw new Error('Le sujet VAPID doit commencer par mailto: ou https:.');
  const publicKey = fromBase64url(keys.publicKey);
  const privateKey = fromBase64url(keys.privateKey);
  if (!publicKey || !isP256Point(publicKey)) throw new Error('Clé publique VAPID invalide.');
  if (privateKey?.length !== 32) throw new Error('Clé privée VAPID invalide.');
  const key = createPrivateKey({ key: rawToJwk(publicKey, privateKey), format: 'jwk' });

  const header = { typ: 'JWT', alg: 'ES256' };
  const claims = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + JWT_LIFETIME,
    sub: subject,
  };
  const encode = (part: object) => Buffer.from(JSON.stringify(part)).toString('base64url');
  const unsigned = `${encode(header)}.${encode(claims)}`;
  // Format JOSE : r | s sur 64 octets (et non DER).
  const signature = sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${signature.toString('base64url')}, k=${publicKey.toString('base64url')}`;
}

/**
 * Envoie `data` (sérialisé en JSON puis chiffré) à un abonné.
 * 200/201 → `sent` ; 404/410 → `gone` (supprimer l'abonnement) ; tout le reste → `failed`.
 * Ne lève jamais d'exception ; délai maximal de 15 s.
 */
export async function sendPush(
  sub: PushSubscriptionJSON,
  data: unknown,
  keys: VapidKeys,
  subject: string,
  transport: typeof fetch = fetch,
  ttlSeconds = DEFAULT_TTL,
): Promise<PushResult> {
  try {
    const json = JSON.stringify(data);
    if (json === undefined) return 'failed';
    const body = encryptPayload(Buffer.from(json, 'utf8'), sub);
    if (body.length > MAX_BODY) return 'failed';
    const ttl = Number.isFinite(ttlSeconds) ? Math.max(0, Math.floor(ttlSeconds)) : DEFAULT_TTL;
    const response = await transport(sub.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        TTL: String(ttl),
        Urgency: 'normal',
        Authorization: vapidAuthorization(sub.endpoint, keys, subject),
      },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    // Libère la connexion sans lire la réponse (inutile ici).
    await response.body?.cancel().catch(() => {});
    if (response.status === 200 || response.status === 201) return 'sent';
    if (response.status === 404 || response.status === 410) return 'gone';
    return 'failed';
  } catch {
    return 'failed';
  }
}

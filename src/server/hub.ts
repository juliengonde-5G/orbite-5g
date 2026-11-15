/**
 * Plateforme multi-familles : annuaire des familles, invitations et plafonds
 * d'usage de la clé Anthropic partagée.
 *
 * Principes (décidés par Julien, 15 nov. 2026) :
 * - une seule installation héberge plusieurs familles, chacune isolée : son propre
 *   dossier de données (donc son propre coffre chiffré, sa propre clé de coffre),
 *   son propre lien `/f/<nom>-<suffixe>`, ses propres profils et son propre
 *   compte ÉcoleDirecte ;
 * - une famille ne se crée que sur invitation : un lien à usage unique, valable
 *   sept jours, que génère l'administrateur de la famille « maison » ;
 * - la clé Anthropic est unique (celle de l'administrateur de la famille maison) ;
 *   chaque famille a un plafond quotidien d'appels, que l'administrateur règle et
 *   peut couper en suspendant la famille.
 *
 * Points d'attention :
 * - le jeton d'invitation n'est jamais stocké : seule son empreinte SHA-256 l'est ;
 * - le suffixe aléatoire du lien rend l'adresse d'une famille impossible à deviner ;
 * - une famille suspendue garde ses données ; rien n'est jamais supprimé ici.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { join } from 'node:path';
import { parisDate } from '../shared/metrics.ts';
import { ClaudeCoach, type Coach } from './coach.ts';
import { MeteredCoach, QuotaError, type UsageMeter } from './quota.ts';
import { Vault } from './vault.ts';

export class HubError extends Error {
  readonly code: number;
  constructor(message: string, code = 400) {
    super(message);
    this.code = code;
  }
}

export interface FamilyRecord {
  slug: string;
  name: string;
  /** Profil parent administrateur créé avec la famille (`Prénom:parent+admin`). */
  seed: string;
  createdAt: number;
  disabled: boolean;
  /** Appels à Claude autorisés par jour (conseils et modules de soutien). */
  dailyLimit: number;
}

interface InviteRecord {
  hash: string;
  label: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  slug: string | null;
}

interface HubDoc {
  version: 1;
  families: FamilyRecord[];
  invites: InviteRecord[];
  usage: Record<string, { date: string; calls: number }>;
}

export type { FamilyView, InviteView } from '../shared/hub.ts';
import type { FamilyView, InviteView } from '../shared/hub.ts';

const RESERVED = new Set([
  'f',
  'api',
  'invite',
  'hub',
  'admin',
  'healthz',
  'client',
  'shared',
  'icons',
  'fonts',
  'style',
  'sw',
  'manifest',
  'favicon',
  'famille',
]);
const SUFFIX = 'abcdefghjkmnpqrstuvwxyz23456789';
const INVITE_DAYS = 7;
export const DEFAULT_LIMIT = 30;
export const MAX_LIMIT = 500;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9]{4}$/;

export function slugify(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 20)
    .replace(/-$/, '');
  return RESERVED.has(base) || !base ? 'famille' : base;
}

export interface HubOptions {
  /** Dossier de la plateforme : les familles vivent dans `<dossier>/families/<nom>`. */
  directory: string;
  now?: () => Date;
  /** Fabrique du conseiller de chaque famille (tests). */
  coachFactory?: () => Coach;
}

export class Hub {
  private doc: HubDoc;
  private readonly vault: Vault;
  private readonly directory: string;
  private readonly now: () => Date;
  private readonly coachFactory: () => Coach;
  private readonly coaches = new Map<string, Coach>();
  private master: string | null = null;
  private failures: number[] = [];

  constructor(vault: Vault, options: HubOptions) {
    this.vault = vault;
    this.directory = options.directory;
    this.now = options.now ?? (() => new Date());
    this.coachFactory = options.coachFactory ?? (() => new ClaudeCoach(''));
    this.doc = vault.load<HubDoc>('hub', { version: 1, families: [], invites: [], usage: {} });
  }

  private save(): void {
    this.vault.save('hub', this.doc);
  }

  familyDir(slug: string): string {
    if (!slugPattern.test(slug)) throw new HubError('Famille introuvable.', 404);
    return join(this.directory, 'families', slug);
  }

  /* ---------- Invitations ---------- */

  /** Crée une invitation à usage unique ; le jeton n'est rendu qu'ici. */
  invite(label: unknown): string {
    const text = typeof label === 'string' ? label.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
    const token = randomBytes(18).toString('base64url');
    const at = this.now().getTime();
    this.doc.invites.push({
      hash: hash(token),
      label: text || 'Nouvelle famille',
      createdAt: at,
      expiresAt: at + INVITE_DAYS * 86400000,
      usedAt: null,
      slug: null,
    });
    // Les invitations de plus d'un mois (utilisées ou périmées) ne servent plus à rien.
    this.doc.invites = this.doc.invites.filter((i) => at - i.expiresAt < 30 * 86400000);
    this.save();
    return token;
  }

  invites(): InviteView[] {
    const at = this.now().getTime();
    return this.doc.invites
      .filter((i) => !i.usedAt && i.expiresAt > at)
      .map((i) => ({ label: i.label, createdAt: i.createdAt, expiresAt: i.expiresAt, used: false }));
  }

  private find(token: unknown): InviteRecord {
    const at = this.now().getTime();
    this.failures = this.failures.filter((t) => at - t < 3600000);
    if (this.failures.length >= 20) throw new HubError('Trop d’essais. Réessaie dans une heure.', 429);
    const invite =
      typeof token === 'string' && /^[A-Za-z0-9_-]{20,40}$/.test(token)
        ? this.doc.invites.find((i) => i.hash === hash(token))
        : undefined;
    if (!invite || invite.usedAt || invite.expiresAt <= at) {
      this.failures.push(at);
      throw new HubError('Cette invitation est invalide, déjà utilisée ou périmée.', 404);
    }
    return invite;
  }

  /** Vérifie une invitation sans la consommer ; rend son libellé. */
  inspect(token: unknown): { label: string } {
    return { label: this.find(token).label };
  }

  /**
   * Crée la famille : enregistre l'annuaire, consomme l'invitation et prépare le coffre
   * de la famille avec un code d'installation que la famille ne voit jamais (la page
   * d'invitation le présente elle-même au serveur pour choisir le PIN du parent).
   */
  create(
    token: unknown,
    input: { familyName?: unknown; adminName?: unknown },
  ): { family: FamilyRecord; setupCode: string } {
    const invite = this.find(token);
    const familyName = typeof input.familyName === 'string' ? input.familyName.replace(/\s+/g, ' ').trim() : '';
    const adminName = typeof input.adminName === 'string' ? input.adminName.replace(/\s+/g, ' ').trim() : '';
    if (familyName.length < 2 || familyName.length > 40)
      throw new HubError('Donne un nom de famille (2 à 40 caractères).');
    if (adminName.length < 2 || adminName.length > 30) throw new HubError('Ton prénom doit faire 2 à 30 caractères.');
    if (/[,;:+]/.test(adminName)) throw new HubError('Le prénom ne peut pas contenir « , », « ; », « : » ni « + ».');
    if (!/[\p{L}\p{N}]/u.test(adminName)) throw new HubError('Ton prénom doit contenir au moins une lettre.');
    let slug = '';
    do {
      slug = `${slugify(familyName)}-${Array.from({ length: 4 }, () => SUFFIX[randomInt(SUFFIX.length)]).join('')}`;
    } while (this.doc.families.some((f) => f.slug === slug));
    const setupCode = Array.from({ length: 8 }, () => SUFFIX[randomInt(SUFFIX.length)]!.toUpperCase()).join('');
    const family: FamilyRecord = {
      slug,
      name: familyName,
      seed: `${adminName}:parent+admin`,
      createdAt: this.now().getTime(),
      disabled: false,
      dailyLimit: DEFAULT_LIMIT,
    };
    new Vault(this.familyDir(slug)).save('secret', {
      version: 1,
      secret: randomBytes(32).toString('hex'),
      setupCode,
    });
    invite.usedAt = this.now().getTime();
    invite.slug = slug;
    this.doc.families.push(family);
    this.save();
    return { family, setupCode };
  }

  /* ---------- Annuaire ---------- */

  get(slug: string): FamilyRecord | undefined {
    return this.doc.families.find((f) => f.slug === slug);
  }

  all(): readonly FamilyRecord[] {
    return this.doc.families;
  }

  private used(slug: string): number {
    const u = this.doc.usage[slug];
    return u && u.date === parisDate(this.now()) ? u.calls : 0;
  }

  list(): FamilyView[] {
    return this.doc.families.map((f) => ({
      slug: f.slug,
      name: f.name,
      createdAt: f.createdAt,
      disabled: f.disabled,
      dailyLimit: f.dailyLimit,
      usedToday: this.used(f.slug),
    }));
  }

  update(slug: unknown, changes: { disabled?: unknown; dailyLimit?: unknown }): void {
    const family = typeof slug === 'string' ? this.get(slug) : undefined;
    if (!family) throw new HubError('Famille introuvable.', 404);
    if (typeof changes.disabled === 'boolean') family.disabled = changes.disabled;
    if (changes.dailyLimit !== undefined) {
      const limit = Number(changes.dailyLimit);
      if (!Number.isInteger(limit) || limit < 0 || limit > MAX_LIMIT)
        throw new HubError(`Le plafond doit être un nombre entre 0 et ${MAX_LIMIT}.`);
      family.dailyLimit = limit;
    }
    this.save();
  }

  /* ---------- Clé partagée ---------- */

  meter(slug: string): UsageMeter {
    return {
      take: () => {
        const family = this.get(slug);
        if (!family || family.disabled) throw new QuotaError('Cette famille est suspendue.');
        const today = parisDate(this.now());
        const usage = this.doc.usage[slug];
        const calls = usage && usage.date === today ? usage.calls : 0;
        if (calls >= family.dailyLimit)
          throw new QuotaError('La limite quotidienne de conseils et d’exercices est atteinte. Réessaie demain.');
        this.doc.usage[slug] = { date: today, calls: calls + 1 };
        this.save();
      },
    };
  }

  /** Clé effective de la famille « maison » ; chaque famille s'en sert via son propre conseiller. */
  setMasterKey(key: string | null): void {
    this.master = key;
    for (const coach of this.coaches.values()) coach.setKey(key);
  }

  coachFor(slug: string): Coach {
    let coach = this.coaches.get(slug);
    if (!coach) {
      coach = this.coachFactory();
      coach.setKey(this.master);
      this.coaches.set(slug, coach);
    }
    return new MeteredCoach(coach, this.meter(slug));
  }
}

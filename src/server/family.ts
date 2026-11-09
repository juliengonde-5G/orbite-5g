/**
 * Comptes de la famille.
 *
 * Rôle : qui peut ouvrir Orbite, avec quels droits. Chaque membre a un profil
 * (parent ou enfant), un code PIN à six chiffres et ses préférences. Un appareil
 * connecté reçoit un jeton aléatoire, conservé dans un cookie HttpOnly ; le
 * serveur n'en garde qu'une empreinte SHA-256.
 *
 * Fonctionnement :
 * - Premier démarrage : les profils sont créés à partir de `ORBITE_FAMILY`
 *   (« Julien:parent+admin, Ilan:enfant:5e… »). Aucun PIN n'existe encore.
 * - Le parent administrateur choisit son PIN depuis le réseau de la maison
 *   (contrôle fait par le serveur), puis génère un code d'activation à usage
 *   unique pour chaque autre membre, qui choisit lui-même son PIN.
 * - Cinq PIN faux bloquent le profil 1 minute, puis 2, 4… jusqu'à 1 heure.
 * - Un appareil reste connecté 180 jours après sa dernière ouverture.
 *
 * Points d'attention : un PIN à six chiffres ne résiste pas à une attaque hors
 * ligne ; il est haché (scrypt) et stocké dans le coffre chiffré, et seul le
 * serveur, qui limite les essais, peut le vérifier.
 */
import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Vault } from './vault.ts';
import type { ColorKey, MemberView, Prefs, Role } from '../shared/types.ts';

export class FamilyError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

interface Hash {
  salt: string;
  hash: string;
}

export interface MemberRecord {
  id: string;
  name: string;
  role: Role;
  admin: boolean;
  grade: string;
  color: ColorKey;
  /** Élève ÉcoleDirecte rattaché (identifiant `compte:élève`), pour un enfant. */
  studentId: string | null;
  pin: Hash | null;
  activation: { hash: string; expires: number } | null;
  failures: number;
  lockedUntil: number;
  prefs: Prefs;
  createdAt: number;
}

interface DeviceRecord {
  hash: string;
  memberId: string;
  created: number;
  seen: number;
  expires: number;
}

interface FamilyDoc {
  version: 1;
  members: MemberRecord[];
  devices: DeviceRecord[];
}

export const COLORS: ColorKey[] = ['comete', 'soleil', 'lagon', 'corail', 'menthe', 'prune'];
const DEVICE_DAYS = 180;
const ACTIVATION_HOURS = 72;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const DEFAULT_PREFS: Prefs = { theme: 'auto', reading: 'standard' };

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function hashPin(pin: string, salt = randomBytes(16).toString('hex')): Hash {
  return { salt, hash: scryptSync(pin, salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex') };
}

function samePin(pin: string, stored: Hash): boolean {
  const candidate = Buffer.from(hashPin(pin, stored.salt).hash, 'hex');
  const expected = Buffer.from(stored.hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/** Refuse les PIN devinables en premier : chiffres tous identiques ou suite croissante/décroissante. */
export function checkPin(pin: unknown): string {
  if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) throw new FamilyError('Le code doit faire 6 chiffres.');
  const digits = [...pin].map(Number);
  const steps = new Set(digits.slice(1).map((d, i) => d - (digits[i] ?? 0)));
  if (steps.size === 1 && [0, 1, -1].includes([...steps][0] ?? 9))
    throw new FamilyError('Ce code est trop facile à deviner. Choisis-en un autre.');
  return pin;
}

const cleanName = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 40)
    throw new FamilyError('Indique un prénom de 1 à 40 caractères.');
  return value.trim();
};

/** Interprète `ORBITE_FAMILY` : « Prénom:rôle[:classe] » séparés par des virgules. */
export function parseSeed(seed: string): Pick<MemberRecord, 'name' | 'role' | 'admin' | 'grade'>[] {
  return seed
    .split(/[,;\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name = '', role = '', grade = ''] = entry.split(':').map((s) => s.trim());
      const r = role.toLowerCase();
      return {
        name: cleanName(name),
        role: r.startsWith('parent') ? 'parent' : 'child',
        admin: r.includes('admin'),
        grade: grade.slice(0, 12),
      };
    });
}

export class Family {
  private doc: FamilyDoc;
  private readonly vault: Vault;
  private lastSave = 0;

  constructor(vault: Vault, seed = '') {
    this.vault = vault;
    this.doc = vault.load<FamilyDoc>('family', { version: 1, members: [], devices: [] });
    if (!this.doc.members.length && seed.trim()) {
      const entries = parseSeed(seed);
      // Sans administrateur désigné, le premier parent le devient.
      if (!entries.some((e) => e.admin)) {
        const firstParent = entries.find((e) => e.role === 'parent');
        if (firstParent) firstParent.admin = true;
      }
      for (const entry of entries) this.create(entry);
      this.save();
    }
  }

  private save(): void {
    this.vault.save('family', this.doc);
    this.lastSave = Date.now();
  }

  private create(input: Pick<MemberRecord, 'name' | 'role' | 'admin' | 'grade'>): MemberRecord {
    const used = new Set(this.doc.members.map((m) => m.color));
    const member: MemberRecord = {
      id: randomBytes(6).toString('hex'),
      name: input.name,
      role: input.role,
      admin: input.role === 'parent' && input.admin,
      grade: input.grade,
      color: COLORS.find((c) => !used.has(c)) ?? COLORS[this.doc.members.length % COLORS.length] ?? 'comete',
      studentId: null,
      pin: null,
      activation: null,
      failures: 0,
      lockedUntil: 0,
      prefs: { ...DEFAULT_PREFS },
      createdAt: Date.now(),
    };
    this.doc.members.push(member);
    return member;
  }

  get members(): readonly MemberRecord[] {
    return this.doc.members;
  }

  member(id: unknown): MemberRecord {
    const found = this.doc.members.find((m) => m.id === id);
    if (!found) throw new FamilyError('Profil introuvable.', 404);
    return found;
  }

  view(m: MemberRecord, now = Date.now()): MemberView {
    return {
      id: m.id,
      name: m.name,
      role: m.role,
      admin: m.admin,
      grade: m.grade,
      color: m.color,
      studentId: m.studentId,
      hasPin: !!m.pin,
      activationPending: !!m.activation && m.activation.expires > now,
      lockedUntil: m.lockedUntil > now ? m.lockedUntil : 0,
      prefs: m.prefs,
    };
  }

  /** Vrai tant qu'aucun administrateur n'a choisi son PIN : l'écran d'installation est proposé. */
  get setupNeeded(): boolean {
    return !this.doc.members.some((m) => m.admin && m.pin);
  }

  /** Premier PIN de l'administrateur ; le serveur vérifie au préalable que la demande vient de la maison. */
  claimAdmin(memberId: unknown, pin: unknown): string {
    if (!this.setupNeeded) throw new FamilyError('L’installation est déjà terminée.', 409);
    const m = this.member(memberId);
    if (!m.admin) throw new FamilyError('Seul le parent administrateur peut terminer l’installation.', 403);
    m.pin = hashPin(checkPin(pin));
    return this.openDevice(m);
  }

  activate(memberId: unknown, code: unknown, pin: unknown): string {
    const m = this.member(memberId);
    const now = Date.now();
    this.guard(m, now);
    const normalized = typeof code === 'string' ? code.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
    if (!m.activation || m.activation.expires <= now || sha256(normalized) !== m.activation.hash) {
      this.fail(m, now);
      throw new FamilyError('Code d’activation incorrect ou expiré. Demande un nouveau code à un parent.', 403);
    }
    m.pin = hashPin(checkPin(pin));
    m.activation = null;
    m.failures = 0;
    m.lockedUntil = 0;
    // Un nouveau PIN déconnecte les anciens appareils du profil.
    this.doc.devices = this.doc.devices.filter((d) => d.memberId !== m.id);
    return this.openDevice(m);
  }

  login(memberId: unknown, pin: unknown): string {
    const m = this.member(memberId);
    const now = Date.now();
    this.guard(m, now);
    if (!m.pin) throw new FamilyError('Ce profil n’est pas encore activé.', 409);
    if (typeof pin !== 'string' || !/^\d{6}$/.test(pin) || !samePin(pin, m.pin)) {
      this.fail(m, now);
      const left = Math.max(0, 5 - m.failures);
      throw new FamilyError(
        left
          ? `Code incorrect. Encore ${left} essai${left > 1 ? 's' : ''}.`
          : 'Code incorrect. Profil bloqué un moment.',
        403,
      );
    }
    m.failures = 0;
    m.lockedUntil = 0;
    return this.openDevice(m);
  }

  private guard(m: MemberRecord, now: number): void {
    if (m.lockedUntil > now) {
      const minutes = Math.ceil((m.lockedUntil - now) / 60000);
      throw new FamilyError(`Trop d’essais. Réessaie dans ${minutes} min.`, 429);
    }
  }

  private fail(m: MemberRecord, now: number): void {
    m.failures += 1;
    if (m.failures >= 5) m.lockedUntil = now + Math.min(60, 2 ** (m.failures - 5)) * 60000;
    this.save();
  }

  private openDevice(m: MemberRecord): string {
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    this.doc.devices = this.doc.devices.filter((d) => d.expires > now);
    this.doc.devices.push({
      hash: sha256(token),
      memberId: m.id,
      created: now,
      seen: now,
      expires: now + DEVICE_DAYS * 86400000,
    });
    this.save();
    return token;
  }

  /** Membre associé au jeton d'un appareil ; prolonge sa validité (écriture au plus une fois par heure). */
  authenticate(token: string | undefined): MemberRecord | undefined {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
    const now = Date.now();
    const hash = sha256(token);
    const device = this.doc.devices.find((d) => d.hash === hash && d.expires > now);
    if (!device) return undefined;
    const m = this.doc.members.find((x) => x.id === device.memberId);
    if (!m?.pin) return undefined;
    device.seen = now;
    device.expires = now + DEVICE_DAYS * 86400000;
    if (now - this.lastSave > 3600000) this.save();
    return m;
  }

  logout(token: string | undefined): void {
    if (!token) return;
    const hash = sha256(token);
    const before = this.doc.devices.length;
    this.doc.devices = this.doc.devices.filter((d) => d.hash !== hash);
    if (this.doc.devices.length !== before) this.save();
  }

  /** Code à usage unique (72 h) qu'un parent transmet au membre pour qu'il choisisse ou réinitialise son PIN. */
  issueActivation(memberId: unknown): { code: string; expires: number } {
    const m = this.member(memberId);
    const raw = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    const expires = Date.now() + ACTIVATION_HOURS * 3600000;
    m.activation = { hash: sha256(raw), expires };
    m.failures = 0;
    m.lockedUntil = 0;
    this.save();
    return { code: raw.slice(0, 4) + '-' + raw.slice(4), expires };
  }

  add(input: { name?: unknown; role?: unknown; grade?: unknown }): MemberRecord {
    if (this.doc.members.length >= 12) throw new FamilyError('Douze profils au maximum.');
    const member = this.create({
      name: cleanName(input.name),
      role: input.role === 'parent' ? 'parent' : 'child',
      admin: false,
      grade: typeof input.grade === 'string' ? input.grade.trim().slice(0, 12) : '',
    });
    this.save();
    return member;
  }

  update(
    memberId: unknown,
    input: { name?: unknown; grade?: unknown; color?: unknown; studentId?: unknown; admin?: unknown },
    validStudents: readonly string[] = [],
  ): MemberRecord {
    const m = this.member(memberId);
    if (input.name !== undefined) m.name = cleanName(input.name);
    if (typeof input.grade === 'string') m.grade = input.grade.trim().slice(0, 12);
    if (input.color !== undefined) {
      if (!COLORS.includes(input.color as ColorKey)) throw new FamilyError('Couleur inconnue.');
      m.color = input.color as ColorKey;
    }
    if (input.studentId !== undefined) {
      if (input.studentId !== null && !validStudents.includes(String(input.studentId)))
        throw new FamilyError('Élève ÉcoleDirecte introuvable.');
      if (m.role !== 'child') throw new FamilyError('Seul un profil enfant se rattache à un élève.');
      m.studentId = input.studentId === null ? null : String(input.studentId);
    }
    if (typeof input.admin === 'boolean') {
      if (m.role !== 'parent') throw new FamilyError('Seul un parent peut être administrateur.');
      if (!input.admin && this.doc.members.filter((x) => x.admin).length <= 1)
        throw new FamilyError('Il faut garder au moins un administrateur.');
      m.admin = input.admin;
    }
    this.save();
    return m;
  }

  setPrefs(memberId: string, input: { theme?: unknown; reading?: unknown; color?: unknown }): MemberRecord {
    const m = this.member(memberId);
    if (['auto', 'light', 'dark'].includes(input.theme as string)) m.prefs.theme = input.theme as Prefs['theme'];
    if (['standard', 'dyslexia', 'large'].includes(input.reading as string))
      m.prefs.reading = input.reading as Prefs['reading'];
    if (COLORS.includes(input.color as ColorKey)) m.color = input.color as ColorKey;
    this.save();
    return m;
  }

  remove(memberId: unknown): void {
    const m = this.member(memberId);
    if (m.admin && this.doc.members.filter((x) => x.admin).length <= 1)
      throw new FamilyError('Impossible de supprimer le dernier administrateur.');
    this.doc.members = this.doc.members.filter((x) => x.id !== m.id);
    this.doc.devices = this.doc.devices.filter((d) => d.memberId !== m.id);
    this.save();
  }

  signOutEverywhere(memberId: unknown): void {
    const m = this.member(memberId);
    this.doc.devices = this.doc.devices.filter((d) => d.memberId !== m.id);
    this.save();
  }

  /**
   * Rattachement automatique enfant ↔ élève ÉcoleDirecte par prénom, quand il est
   * sans ambiguïté (un seul élève et un seul profil portent ce prénom).
   */
  autoLink(students: readonly { id: string; name: string }[]): boolean {
    const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    let changed = false;
    const taken = new Set(this.doc.members.map((m) => m.studentId).filter(Boolean));
    for (const m of this.doc.members) {
      if (m.role !== 'child' || m.studentId) continue;
      const candidates = students.filter((s) => norm(s.name) === norm(m.name) && !taken.has(s.id));
      const sameName = this.doc.members.filter((x) => x.role === 'child' && norm(x.name) === norm(m.name));
      const first = candidates[0];
      if (candidates.length === 1 && sameName.length === 1 && first) {
        m.studentId = first.id;
        taken.add(first.id);
        changed = true;
      }
    }
    if (changed) this.save();
    return changed;
  }
}

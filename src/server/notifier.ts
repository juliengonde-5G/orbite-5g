/**
 * Notifications de la famille : quoi envoyer, à qui, et quand.
 *
 * Rôle : surveiller ÉcoleDirecte (nouvelles notes, messages, vie scolaire), envoyer
 * le rappel du cartable à 19 h et le récapitulatif du dimanche, via Web Push (`push.ts`).
 *
 * Fonctionnement :
 * - Chaque abonnement est lié à un membre et à l'appareil connecté (empreinte du jeton) :
 *   un appareil déconnecté ne reçoit plus rien et son abonnement est supprimé.
 * - La première lecture d'un canal sert de référence : rien n'est envoyé pour l'existant.
 * - Rien ne part la nuit (22 h – 7 h, heure de Paris) ; ÉcoleDirecte est interrogé au
 *   plus toutes les 40 minutes, et seulement si quelqu'un est abonné.
 *
 * Points d'attention :
 * - Le texte d'une notification s'affiche sur l'écran verrouillé : jamais de note chiffrée,
 *   jamais de comparaison. Un élève ne reçoit que ce qui le concerne.
 * - Les absences et sanctions ne sont envoyées qu'aux parents ; les encouragements aussi à l'élève.
 */
import { generateVapidKeys, sendPush, validSubscription, type PushSubscriptionJSON, type VapidKeys } from './push.ts';
import { noteKey, parisDate, parisHour } from '../shared/metrics.ts';
import type { EdMail } from './ecoledirecte.ts';
import type { Family, MemberRecord } from './family.ts';
import type { Vault } from './vault.ts';
import type { Course, Dashboard, PushPrefs, PushStatus, SchoolLife } from '../shared/types.ts';

export interface PushMessage {
  title: string;
  body: string;
  url: string;
  tag: string;
}

/** Ce dont le notificateur a besoin d'ÉcoleDirecte (sous-ensemble de `EdService`). */
export interface NotifierEd {
  dashboard(maxAge?: number): Promise<{ dashboard: Dashboard | null; stale: boolean }>;
  mailbox(childId: string | null, maxAge?: number): Promise<EdMail[]>;
  schoolLife(childId: string, maxAge?: number): Promise<SchoolLife>;
  timetable(childId: string, date: string, maxAge?: number): Promise<Course[]>;
  status(): { link: string };
}

interface StoredSub {
  memberId: string;
  /** Empreinte de l'appareil connecté (`Family.deviceTag`). */
  tag: string;
  sub: PushSubscriptionJSON;
  created: number;
}

interface PushDoc {
  version: 1;
  vapid: VapidKeys;
  subs: StoredSub[];
  prefs: Record<string, PushPrefs>;
  /** Canal (`notes:<élève>`, `mail:famille`…) → identifiants déjà vus. */
  known: Record<string, string[]>;
  /** Envois uniques déjà faits (`bag:<membre>:<jour>`, `recap:<membre>:<jour>`) → date. */
  sent: Record<string, number>;
  lastScan: number;
}

export const DEFAULT_PREFS: PushPrefs = { notes: true, mail: true, life: true, bag: true, recap: true };
const PREF_KEYS = Object.keys(DEFAULT_PREFS) as (keyof PushPrefs)[];
const SCAN_EVERY = 40 * 60000;
const DAY = 86400000;
const MAX_SUBS = 6;

export interface NotifierOptions {
  vault: Vault;
  family: Family;
  ed: NotifierEd;
  /** Contact VAPID : `mailto:` ou adresse https du service. */
  subject: string;
  send?: typeof sendPush;
  now?: () => Date;
}

export class Notifier {
  private doc: PushDoc;
  private running = false;
  private readonly send: typeof sendPush;
  private readonly now: () => Date;
  private readonly options: NotifierOptions;

  constructor(options: NotifierOptions) {
    this.options = options;
    this.send = options.send ?? sendPush;
    this.now = options.now ?? (() => new Date());
    this.doc = options.vault.load<PushDoc>('push', {
      version: 1,
      vapid: { publicKey: '', privateKey: '' },
      subs: [],
      prefs: {},
      known: {},
      sent: {},
      lastScan: 0,
    });
    if (!this.doc.vapid.publicKey) {
      this.doc.vapid = generateVapidKeys();
      this.save();
    }
  }

  private save(): void {
    this.options.vault.save('push', this.doc);
  }

  prefs(memberId: string): PushPrefs {
    return { ...DEFAULT_PREFS, ...this.doc.prefs[memberId] };
  }

  status(me: MemberRecord, tag: string): PushStatus {
    return {
      publicKey: this.doc.vapid.publicKey,
      subscribed: this.doc.subs.some((s) => s.memberId === me.id && s.tag === tag && !!tag),
      devices: this.doc.subs.filter((s) => s.memberId === me.id).length,
      prefs: this.prefs(me.id),
    };
  }

  /** Enregistre l'abonnement de cet appareil (remplace l'ancien). `false` si l'abonnement est invalide. */
  subscribe(me: MemberRecord, tag: string, raw: unknown): boolean {
    const sub = validSubscription(raw);
    if (!sub || !tag) return false;
    this.doc.subs = this.doc.subs.filter(
      (s) => s.sub.endpoint !== sub.endpoint && !(s.memberId === me.id && s.tag === tag),
    );
    this.doc.subs.push({ memberId: me.id, tag, sub, created: Date.now() });
    const mine = this.doc.subs.filter((s) => s.memberId === me.id);
    if (mine.length > MAX_SUBS) {
      const oldest = mine.sort((a, b) => a.created - b.created)[0];
      this.doc.subs = this.doc.subs.filter((s) => s !== oldest);
    }
    this.save();
    return true;
  }

  unsubscribe(me: MemberRecord, tag: string): void {
    this.doc.subs = this.doc.subs.filter((s) => !(s.memberId === me.id && s.tag === tag));
    this.save();
  }

  setPrefs(me: MemberRecord, input: unknown): PushPrefs {
    const next = this.prefs(me.id);
    if (input && typeof input === 'object')
      for (const k of PREF_KEYS) {
        const v = (input as Record<string, unknown>)[k];
        if (typeof v === 'boolean') next[k] = v;
      }
    this.doc.prefs[me.id] = next;
    this.save();
    return next;
  }

  /** Oublie un membre supprimé ou réinitialisé. */
  forget(memberId: string): void {
    this.doc.subs = this.doc.subs.filter((s) => s.memberId !== memberId);
    delete this.doc.prefs[memberId];
    this.save();
  }

  /** Envoie à ces membres (préférence `pref` respectée), sur leurs appareils encore connectés. */
  async notify(members: MemberRecord[], message: PushMessage, pref: keyof PushPrefs | null): Promise<number> {
    const ids = new Set(members.filter((m) => !pref || this.prefs(m.id)[pref]).map((m) => m.id));
    const targets = this.doc.subs.filter((s) => ids.has(s.memberId));
    if (!targets.length) return 0;
    let sent = 0;
    const gone = new Set<StoredSub>();
    await Promise.all(
      targets.map(async (s) => {
        if (!this.options.family.deviceActive(s.memberId, s.tag)) {
          gone.add(s);
          return;
        }
        const result = await this.send(s.sub, message, this.doc.vapid, this.options.subject);
        if (result === 'sent') sent++;
        else if (result === 'gone') gone.add(s);
      }),
    );
    if (gone.size) {
      this.doc.subs = this.doc.subs.filter((s) => !gone.has(s));
      this.save();
    }
    return sent;
  }

  private get parents(): MemberRecord[] {
    return this.options.family.members.filter((m) => m.role === 'parent');
  }

  private kidsOf(childId: string): MemberRecord[] {
    return this.options.family.members.filter((m) => m.role === 'child' && m.studentId === childId);
  }

  /** Message famille partagé par un parent : l'élève est prévenu tout de suite. */
  async shared(childIds: string[], subject: string): Promise<void> {
    const kids = childIds.flatMap((id) => this.kidsOf(id));
    await this.notify(
      kids,
      { title: 'Un parent t’a partagé un message', body: subject, url: '/#messages', tag: 'mail-share' },
      'mail',
    );
  }

  /** Identifiants nouveaux depuis la dernière lecture du canal ; la première lecture ne signale rien. */
  private fresh(channel: string, ids: string[]): Set<string> {
    const prev = this.doc.known[channel];
    this.doc.known[channel] = [...new Set([...(prev ?? []), ...ids])].slice(-600);
    if (!prev) return new Set();
    const known = new Set(prev);
    return new Set(ids.filter((id) => !known.has(id)));
  }

  private get hasSubscribers(): boolean {
    return this.doc.subs.length > 0;
  }

  /** Appelé toutes les cinq minutes : surveillance, rappel du cartable, récapitulatif. */
  async tick(): Promise<void> {
    if (this.running || !this.hasSubscribers) return;
    this.running = true;
    try {
      const now = this.now();
      const hour = parisHour(now);
      if (hour < 7 || hour >= 22) return;
      if (this.options.ed.status().link !== 'connected') return;
      if (now.getTime() - this.doc.lastScan >= SCAN_EVERY) await this.scan();
      if (hour === 19) await this.bagReminder(now);
      if (hour >= 18 && hour < 21 && weekday(parisDate(now)) === 0) await this.recap(now);
    } catch {
      // Une panne d'ÉcoleDirecte ne doit jamais faire tomber le serveur : on réessaiera.
    } finally {
      this.running = false;
    }
  }

  /** Lit les nouveautés et prévient les membres concernés. */
  async scan(): Promise<void> {
    const now = this.now();
    this.doc.lastScan = now.getTime();
    const { dashboard } = await this.options.ed.dashboard(30 * 60000);
    if (!dashboard) return this.save();
    const many = dashboard.children.length > 1;
    const who = (name: string) => (many ? `${name} · ` : '');
    const out: Promise<number>[] = [];
    for (const child of dashboard.children) {
      // Notes : récentes seulement (une reprise de l'historique ne doit pas déclencher une avalanche).
      const keys = child.notes.map((n) => noteKey(child.id, n));
      const fresh = this.fresh(`notes:${child.id}`, keys);
      const cut = parisDate(new Date(now.getTime() - 21 * DAY));
      const notes = child.notes.filter((n, i) => fresh.has(keys[i] ?? '') && (n.date ?? '') >= cut);
      if (notes.length) {
        const subjects = [...new Set(notes.map((n) => n.subject.split(' · ')[0] ?? n.subject))];
        const body = notes.length === 1 ? `${subjects[0]} · ${notes[0]?.title ?? ''}` : subjects.slice(0, 4).join(', ');
        const title = notes.length === 1 ? 'Nouvelle note' : `${notes.length} nouvelles notes`;
        const message = { body, url: '/#notes', tag: `notes-${child.id}` };
        out.push(this.notify(this.kidsOf(child.id), { ...message, title }, 'notes'));
        out.push(this.notify(this.parents, { ...message, title: who(child.name) + title }, 'notes'));
      }
      // Messages de l'élève.
      const box = await this.options.ed.mailbox(child.id).catch(() => null);
      if (box) {
        const added = this.fresh(
          `mail:${child.id}`,
          box.map((m) => m.id),
        );
        for (const m of box.filter((m) => added.has(m.id) && !m.read).slice(0, 3)) {
          const message = { body: `${m.from} : ${m.subject}`, url: '/#messages', tag: `mail-${child.id}-${m.id}` };
          out.push(this.notify(this.kidsOf(child.id), { ...message, title: 'Nouveau message' }, 'mail'));
          out.push(this.notify(this.parents, { ...message, title: `${who(child.name)}Nouveau message` }, 'mail'));
        }
      }
      // Vie scolaire.
      const life = await this.options.ed.schoolLife(child.id).catch(() => null);
      if (life) {
        const added = this.fresh(
          `life:${child.id}`,
          life.events.map((e) => e.id),
        );
        for (const e of life.events.filter((e) => added.has(e.id)).slice(0, 3)) {
          const message = { url: '/#vie-scolaire', tag: `life-${child.id}-${e.id}` };
          if (e.kind === 'encouragement') {
            const body = e.title || e.type || 'Bravo !';
            out.push(this.notify(this.kidsOf(child.id), { ...message, title: 'Encouragement', body }, 'life'));
            out.push(this.notify(this.parents, { ...message, title: `${who(child.name)}Encouragement`, body }, 'life'));
          } else if (e.kind !== 'autre') {
            const label = { absence: 'Absence', retard: 'Retard', punition: 'Punition', sanction: 'Sanction' }[e.kind];
            const body = [e.title || e.type, e.reason].filter(Boolean).join(' · ') || 'Voir le détail dans Orbite';
            out.push(this.notify(this.parents, { ...message, title: `${child.name} · ${label}`, body }, 'life'));
          }
        }
      }
    }
    // Messages de la famille (parents).
    const family = await this.options.ed.mailbox(null).catch(() => null);
    if (family) {
      const added = this.fresh(
        'mail:famille',
        family.map((m) => m.id),
      );
      for (const m of family.filter((m) => added.has(m.id) && !m.read).slice(0, 3))
        out.push(
          this.notify(
            this.parents,
            { title: 'Nouveau message', body: `${m.from} : ${m.subject}`, url: '/#messages', tag: `mail-f-${m.id}` },
            'mail',
          ),
        );
    }
    this.save();
    await Promise.all(out);
  }

  /**
   * Envoi unique (`bag:…`, `recap:…`) : on ne le note qu'une fois réussi, pour que les
   * passages suivants de l'heure réessaient après une panne d'ÉcoleDirecte ou du service push.
   */
  private markSent(key: string): void {
    this.doc.sent[key] = Date.now();
    const cut = Date.now() - 30 * DAY;
    for (const [k, t] of Object.entries(this.doc.sent)) if (t < cut) delete this.doc.sent[k];
    this.save();
  }

  /** 19 h : « prépare ton sac » pour chaque élève qui a cours le lendemain. */
  async bagReminder(now: Date): Promise<void> {
    const today = parisDate(now);
    const tomorrow = new Date(Date.parse(today + 'T12:00:00Z') + DAY).toISOString().slice(0, 10);
    if ([0, 6].includes(weekday(tomorrow))) return;
    for (const kid of this.options.family.members.filter((m) => m.role === 'child' && m.studentId)) {
      if (!this.prefs(kid.id).bag || !this.doc.subs.some((s) => s.memberId === kid.id)) continue;
      const key = `bag:${kid.id}:${today}`;
      if (this.doc.sent[key]) continue;
      const courses = await this.options.ed.timetable(kid.studentId as string, tomorrow).catch(() => null);
      if (!courses) continue; // ÉcoleDirecte indisponible : nouvel essai au prochain passage.
      const real = courses.filter((c) => !c.cancelled && c.kind !== 'permanence' && c.subject);
      if (!real.length) {
        this.markSent(key); // pas cours demain : rien à envoyer ce soir
        continue;
      }
      const first = real.sort((a, b) => a.start.localeCompare(b.start))[0];
      const sent = await this.notify(
        [kid],
        {
          title: 'Prépare ton sac pour demain',
          body: `${real.length} cours demain${first ? `, dès ${first.start.replace(':', ' h ')}` : ''}. Coche ce qui est dans ton sac.`,
          url: '/#cartable',
          tag: `bag-${today}`,
        },
        'bag',
      );
      if (sent > 0) this.markSent(key);
    }
  }

  /** Dimanche soir : le récapitulatif de la semaine pour les parents. */
  async recap(now: Date): Promise<void> {
    const today = parisDate(now);
    const parents = this.parents.filter(
      (p) =>
        this.prefs(p.id).recap &&
        this.doc.subs.some((s) => s.memberId === p.id) &&
        !this.doc.sent[`recap:${p.id}:${today}`],
    );
    if (!parents.length) return;
    const { dashboard } = await this.options.ed.dashboard(60 * 60000);
    if (!dashboard) return;
    const from = parisDate(new Date(now.getTime() - 6 * DAY));
    const parts = dashboard.children.map((c) => {
      const n = c.notes.filter((x) => (x.date ?? '') >= from && (x.date ?? '') <= today).length;
      return `${c.name} : ${n ? `${n} note${n > 1 ? 's' : ''}` : 'aucune note'}`;
    });
    for (const p of parents) {
      const sent = await this.notify(
        [p],
        { title: 'Le récap de la semaine', body: parts.join(' · '), url: '/#recap', tag: `recap-${today}` },
        'recap',
      );
      if (sent > 0) this.markSent(`recap:${p.id}:${today}`);
    }
  }

  start(intervalMs = 5 * 60000): NodeJS.Timeout {
    const timer = setInterval(() => void this.tick(), intervalMs);
    timer.unref();
    return timer;
  }
}

const weekday = (date: string): number => new Date(date + 'T12:00:00Z').getUTCDay();

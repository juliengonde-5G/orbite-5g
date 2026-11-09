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
import type { Course, Dashboard, LifeKind, PushPrefs, PushStatus, SchoolLife } from '../shared/types.ts';

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
  /** File d'envoi : nouveautés et partages, envoyés hors heures calmes et retentés après un échec. */
  outbox?: Pending[];
}

interface Pending {
  members: string[];
  pref: keyof PushPrefs | null;
  message: PushMessage;
  created: number;
  /** Appareils (endpoint) déjà servis : un nouvel essai ne leur renvoie rien. */
  done: string[];
}

export const DEFAULT_PREFS: PushPrefs = { notes: true, mail: true, life: true, bag: true, recap: true };
const PREF_KEYS = Object.keys(DEFAULT_PREFS) as (keyof PushPrefs)[];
const SCAN_EVERY = 40 * 60000;
const DAY = 86400000;
const MAX_SUBS = 6;
/** Au-delà, une notification non délivrée est abandonnée (même durée que le TTL push). */
const OUTBOX_TTL = DAY;
const OUTBOX_MAX = 200;
/** Heures calmes, heure de Paris : rien ne part entre 22 h et 7 h. */
const quiet = (now: Date) => {
  const hour = parisHour(now);
  return hour < 7 || hour >= 22;
};

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
  private flushing = false;
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

  /** Message famille partagé par un parent : l'élève est prévenu tout de suite, ou à 7 h la nuit. */
  async shared(childIds: string[], subject: string): Promise<void> {
    this.enqueue(
      childIds.flatMap((id) => this.kidsOf(id)),
      { title: 'Un parent t’a partagé un message', body: subject, url: '/#messages', tag: 'mail-share' },
      'mail',
    );
    this.save();
    await this.flush();
  }

  private enqueue(members: MemberRecord[], message: PushMessage, pref: keyof PushPrefs | null): void {
    if (!members.length) return;
    this.doc.outbox ??= [];
    const outbox = this.doc.outbox;
    outbox.push({ members: members.map((m) => m.id), pref, message, created: this.now().getTime(), done: [] });
    if (outbox.length > OUTBOX_MAX) outbox.splice(0, outbox.length - OUTBOX_MAX);
  }

  /**
   * Envoie la file hors heures calmes. Un appareil servi (ou disparu) est noté ; un échec
   * du service push laisse la notification en file pour le passage suivant, pendant 24 h.
   */
  async flush(): Promise<void> {
    const now = this.now();
    if (this.flushing || quiet(now) || !this.doc.outbox?.length) return;
    this.flushing = true;
    try {
      const gone = new Set<StoredSub>();
      const keep: Pending[] = [];
      for (const entry of this.doc.outbox) {
        if (now.getTime() - entry.created > OUTBOX_TTL) continue;
        const ids = new Set(entry.members.filter((id) => !entry.pref || this.prefs(id)[entry.pref]));
        const targets = this.doc.subs.filter((s) => ids.has(s.memberId) && !entry.done.includes(s.sub.endpoint));
        let pending = false;
        await Promise.all(
          targets.map(async (s) => {
            if (!this.options.family.deviceActive(s.memberId, s.tag)) {
              gone.add(s);
              return;
            }
            const result = await this.send(s.sub, entry.message, this.doc.vapid, this.options.subject);
            if (result === 'failed') pending = true;
            else {
              entry.done.push(s.sub.endpoint);
              if (result === 'gone') gone.add(s);
            }
          }),
        );
        if (pending) keep.push(entry);
      }
      this.doc.outbox = keep;
      if (gone.size) this.doc.subs = this.doc.subs.filter((s) => !gone.has(s));
      this.save();
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Identifiants nouveaux depuis la dernière lecture du canal ; la première lecture ne signale rien.
   * Tout l'instantané courant est gardé (plus 300 anciens identifiants), pour qu'une longue liste
   * ne fasse jamais réapparaître des éléments déjà vus.
   */
  private fresh(channel: string, ids: string[]): Set<string> {
    const prev = this.doc.known[channel];
    const current = new Set(ids);
    this.doc.known[channel] = [...(prev ?? []).filter((id) => !current.has(id)).slice(-300), ...current];
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
      if (quiet(now)) return;
      // D'abord la file (partages de la nuit, envois échoués), même sans ÉcoleDirecte.
      await this.flush();
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
        this.enqueue(this.kidsOf(child.id), { ...message, title }, 'notes');
        this.enqueue(this.parents, { ...message, title: who(child.name) + title }, 'notes');
      }
      // Messages de l'élève.
      const box = await this.options.ed.mailbox(child.id).catch(() => null);
      if (box) {
        const added = this.fresh(
          `mail:${child.id}`,
          box.map((m) => m.id),
        );
        const unread = box.filter((m) => added.has(m.id) && !m.read);
        for (const message of mailMessages(unread, `mail-${child.id}`)) {
          this.enqueue(this.kidsOf(child.id), message, 'mail');
          this.enqueue(this.parents, { ...message, title: who(child.name) + message.title }, 'mail');
        }
      }
      // Vie scolaire : on écarte d'abord ce qui ne se notifie pas, puis on résume au-delà de trois.
      const life = await this.options.ed.schoolLife(child.id).catch(() => null);
      if (life) {
        const added = this.fresh(
          `life:${child.id}`,
          life.events.map((e) => e.id),
        );
        const events = life.events.filter((e) => added.has(e.id) && e.kind !== 'autre');
        const url = '/#vie-scolaire';
        const cheers = events.filter((e) => e.kind === 'encouragement');
        if (cheers.length) {
          const body =
            cheers.length === 1
              ? cheers[0]?.title || cheers[0]?.type || 'Bravo !'
              : `${cheers.length} encouragements : ${cheers
                  .map((e) => e.title || e.type)
                  .filter(Boolean)
                  .slice(0, 3)
                  .join(', ')}`;
          const title = cheers.length === 1 ? 'Encouragement' : 'Encouragements';
          const tag = `life-${child.id}-cheer-${cheers[0]?.id ?? ''}`;
          this.enqueue(this.kidsOf(child.id), { title, body, url, tag }, 'life');
          this.enqueue(this.parents, { title: who(child.name) + title, body, url, tag }, 'life');
        }
        const alerts = events.filter((e) => e.kind !== 'encouragement');
        if (alerts.length > 3) {
          const counts = new Map<string, number>();
          for (const e of alerts) counts.set(LIFE_LABEL[e.kind], (counts.get(LIFE_LABEL[e.kind]) ?? 0) + 1);
          const body = [...counts].map(([label, n]) => `${n} ${label.toLowerCase()}${n > 1 ? 's' : ''}`).join(', ');
          this.enqueue(
            this.parents,
            { title: `${child.name} · Vie scolaire`, body, url, tag: `life-${child.id}-batch-${alerts[0]?.id ?? ''}` },
            'life',
          );
        } else
          for (const e of alerts) {
            const body = [e.title || e.type, e.reason].filter(Boolean).join(' · ') || 'Voir le détail dans Orbite';
            this.enqueue(
              this.parents,
              { title: `${child.name} · ${LIFE_LABEL[e.kind]}`, body, url, tag: `life-${child.id}-${e.id}` },
              'life',
            );
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
      for (const message of mailMessages(
        family.filter((m) => added.has(m.id) && !m.read),
        'mail-f',
      ))
        this.enqueue(this.parents, message, 'mail');
    }
    this.save();
    await this.flush();
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

const LIFE_LABEL: Record<LifeKind, string> = {
  absence: 'Absence',
  retard: 'Retard',
  punition: 'Punition',
  sanction: 'Sanction',
  encouragement: 'Encouragement',
  autre: 'Événement',
};

/** Jusqu'à trois messages : une notification chacun ; au-delà, une seule qui les résume tous. */
function mailMessages(list: EdMail[], tag: string): PushMessage[] {
  if (list.length <= 3)
    return list.map((m) => ({
      title: 'Nouveau message',
      body: `${m.from} : ${m.subject}`,
      url: '/#messages',
      tag: `${tag}-${m.id}`,
    }));
  return [
    {
      title: `${list.length} nouveaux messages`,
      body: `${list
        .slice(0, 3)
        .map((m) => m.subject)
        .join(' · ')} …`,
      url: '/#messages',
      tag: `${tag}-batch-${list[0]?.id ?? ''}`,
    },
  ];
}

const weekday = (date: string): number => new Date(date + 'T12:00:00Z').getUTCDay();

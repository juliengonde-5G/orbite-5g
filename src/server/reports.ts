/**
 * Signalements de la famille : un problème, une idée ou une question écrits
 * depuis l'appli, lus par le parent administrateur.
 *
 * Principes :
 * - tout membre peut signaler, seul l'administrateur lit et classe ;
 * - on garde le texte, le prénom de l'auteur, l'écran et la version, rien d'autre
 *   (ni notes, ni identifiants, ni informations sur l'appareil) ;
 * - au plus cinq signalements par membre et par jour, deux cents en tout (les plus
 *   anciens traités partent d'abord) : le coffre ne grossit pas sans fin.
 */
import { randomUUID } from 'node:crypto';
import { parisDate } from '../shared/metrics.ts';
import { REPORT_KINDS, REPORT_MAX, type ReportView } from '../shared/releases.ts';
import type { Vault } from './vault.ts';

interface ReportRecord extends ReportView {
  memberId: string;
}

interface ReportsDoc {
  version: 1;
  items: ReportRecord[];
}

export class ReportError extends Error {
  readonly code: number;
  constructor(message: string, code = 400) {
    super(message);
    this.code = code;
  }
}

const PER_DAY = 5;
const KEEP = 200;
const SCREEN = /^[a-z-]{1,20}$/;

export class Reports {
  private doc: ReportsDoc;
  private readonly vault: Vault;
  private readonly now: () => Date;

  constructor(vault: Vault, now: () => Date = () => new Date()) {
    this.vault = vault;
    this.now = now;
    this.doc = vault.load<ReportsDoc>('reports', { version: 1, items: [] });
  }

  private save(): void {
    this.vault.save('reports', this.doc);
  }

  add(
    member: { id: string; name: string },
    input: { kind?: unknown; text?: unknown; screen?: unknown },
    version: string,
  ): void {
    const kind = REPORT_KINDS.find((k) => k === input.kind);
    if (!kind) throw new ReportError('Choisis le type de signalement.');
    const text = typeof input.text === 'string' ? input.text.replace(/\s+/g, ' ').trim() : '';
    if (text.length < 5) throw new ReportError('Explique en quelques mots ce qui se passe.');
    if (text.length > REPORT_MAX) throw new ReportError(`Message trop long (${REPORT_MAX} caractères au plus).`);
    const today = parisDate(this.now());
    const sent = this.doc.items.filter((r) => r.memberId === member.id && parisDate(new Date(r.at)) === today).length;
    if (sent >= PER_DAY) throw new ReportError('Déjà cinq signalements aujourd’hui. Reviens demain.', 429);
    const screen = typeof input.screen === 'string' && SCREEN.test(input.screen) ? input.screen : 'accueil';
    this.doc.items.push({
      id: randomUUID(),
      memberId: member.id,
      at: this.now().getTime(),
      by: member.name,
      kind,
      text,
      screen,
      version,
      done: false,
    });
    if (this.doc.items.length > KEEP) {
      const drop = this.doc.items.findIndex((r) => r.done);
      this.doc.items.splice(drop >= 0 ? drop : 0, 1);
    }
    this.save();
  }

  /** Du plus récent au plus ancien ; les traités après les ouverts. */
  list(): ReportView[] {
    return this.doc.items
      .map(({ memberId: _memberId, ...view }) => view)
      .sort((a, b) => Number(a.done) - Number(b.done) || b.at - a.at);
  }

  open(): number {
    return this.doc.items.filter((r) => !r.done).length;
  }

  resolve(id: unknown, done: boolean): void {
    const item = this.doc.items.find((r) => r.id === id);
    if (!item) throw new ReportError('Signalement introuvable.', 404);
    item.done = done;
    this.save();
  }

  remove(id: unknown): void {
    const at = this.doc.items.findIndex((r) => r.id === id);
    if (at < 0) throw new ReportError('Signalement introuvable.', 404);
    this.doc.items.splice(at, 1);
    this.save();
  }
}

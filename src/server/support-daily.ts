/**
 * Audit quotidien du soutien scolaire et notifications aux élèves.
 *
 * Rôle : chaque matin (dès 6 h, heure de Paris), relire les évaluations de chaque
 * élève dont le soutien est activé, fixer ses trois compétences du jour
 * (`Support.auditDay`), puis le prévenir. Les notifications passent par la file du
 * notificateur : rien entre 22 h et 7 h, un nouvel essai si le service push tombe.
 *
 * Fonctionnement : `runDailyAudit` est appelé toutes les cinq minutes par le serveur ;
 * il ne fait rien tant que l'audit du jour est fait et la notification partie.
 *
 * Points d'attention : sans données fraîches d'ÉcoleDirecte (panne, compte non relié), l'audit est
 * reporté au passage suivant ; le plan reste alors calculé à la première ouverture.
 */
import { parisHour } from '../shared/metrics.ts';
import { activationMessage, dailyMessage } from '../shared/support.ts';
import type { Dashboard } from '../shared/types.ts';
import type { Family } from './family.ts';
import type { Notifier } from './notifier.ts';
import type { Support } from './support.ts';

export const AUDIT_HOUR = 6;

export interface DailyAuditOptions {
  support: Support;
  family: Family;
  notifier: Notifier;
  ed: { dashboard(maxAge?: number): Promise<{ dashboard: Dashboard | null; stale: boolean }> };
  now?: () => Date;
}

/** Les profils élèves rattachés à un enfant ÉcoleDirecte. */
const pupils = (family: Family, childId: string) =>
  family.members.filter((m) => m.role === 'child' && m.studentId === childId);

/** Audite chaque élève dont le soutien est activé et envoie « tes compétences du jour ». */
export async function runDailyAudit(options: DailyAuditOptions): Promise<number> {
  const { support, family, notifier, ed } = options;
  const now = (options.now ?? (() => new Date()))();
  if (parisHour(now) < AUDIT_HOUR) return 0;
  const enabled = support.enabledChildren();
  if (!enabled.length) return 0;
  const { dashboard, stale } = await ed.dashboard(30 * 60000).catch(() => ({ dashboard: null, stale: true }));
  // Données anciennes (ÉcoleDirecte en panne) : on réessaie au passage suivant plutôt que de figer un plan périmé.
  if (!dashboard || stale) return 0;
  let notified = 0;
  for (const childId of enabled) {
    const child = dashboard.children.find((c) => c.id === childId);
    if (!child) continue;
    support.auditDay(childId, child);
    const daily = support.pendingNotice(childId);
    if (!daily) continue;
    for (const kid of pupils(family, childId)) {
      const message = dailyMessage(kid.name, child.className, daily.items);
      await notifier.queue([kid], { ...message, url: '/', tag: `support-${daily.date}` }, 'support');
      notified++;
    }
    support.markNotified(childId);
  }
  return notified;
}

/** Prévient l'élève qu'un parent vient d'activer son soutien, avec un ton adapté à sa classe. */
export async function announceActivation(
  family: Family,
  notifier: Notifier,
  childId: string,
  className: string | undefined,
): Promise<void> {
  for (const kid of pupils(family, childId)) {
    const message = activationMessage(kid.name, className);
    await notifier.queue([kid], { ...message, url: '/', tag: 'support-on' }, 'support');
  }
}

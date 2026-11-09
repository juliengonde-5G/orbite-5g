/**
 * Calculs partagés sur les notes, les dates et les classes.
 *
 * Rôle : toute la logique « métier » sans entrée-sortie. Moyennes pondérées sur 20,
 * tendance sur 30 jours, écart à la classe, regroupement par matière, courbe
 * d'évolution, notes de la semaine, filtre des classes du secondaire, validation
 * des photos et dates à l'heure de Paris.
 *
 * Fonctionnement : fonctions pures, exécutées des deux côtés. Le serveur les importe
 * (`isSecondary`, `photoUrl`, `parisDate`) et le navigateur charge la version
 * compilée `/shared/metrics.js`. Le fichier ne doit donc dépendre ni de Node ni du DOM.
 *
 * Points d'attention :
 * - Une note n'entre dans un calcul que si `valid()` l'accepte : chiffrée, barème
 *   et coefficient strictement positifs, non exclue. Les notes sont ramenées sur
 *   20, puis pondérées par leur coefficient.
 * - Les jours sont des jours civils à Paris (`parisDate`) : ne pas utiliser
 *   `toISOString()` sur « maintenant », qui donnerait la date UTC et décalerait
 *   les devoirs ou la semaine autour de minuit.
 * - `isSecondary` s'appuie sur des libellés de classe libres ; ses cas sont
 *   couverts par `test/metrics.test.ts`.
 *
 * Liens : `src/client/views.ts` et `charts.ts` (affichage), `src/client/coaching.ts` (résumés IA),
 * `src/server/ecoledirecte.ts` (filtrage et dates).
 */
import type { Gradable } from './types.ts';

/** Note utilisable dans un calcul : valeur, barème et coefficient garantis numériques. */
export type ValidGrade<T extends Gradable = Gradable> = T & {
  value: number;
  outOf: number;
  coefficient: number;
};
type DatedGrade<T extends Gradable> = ValidGrade<T> & { date: string };
type PairedGrade<T extends Gradable> = ValidGrade<T> & { classAverage: number };

export interface Metrics {
  average: number | null;
  trend: number | null;
  recentCount: number;
  previousCount: number;
  gap: number | null;
  classAverage: number | null;
  pairedCount: number;
  count: number;
}

export interface SubjectGroup<T> {
  id: string;
  label: string;
  notes: T[];
}

export interface TimelinePoint<T extends Gradable> {
  date: string;
  time: number;
  notes: DatedGrade<T>[];
  average: number | null;
  classAverage: number | null;
  trend: number | null;
  count: number;
}

export type GradeBand = 'good' | 'average' | 'poor' | 'neutral';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export const valid = <T extends Gradable>(n: T): n is ValidGrade<T> =>
  !n.excluded && finite(n.value) && finite(n.outOf) && n.outOf > 0 && finite(n.coefficient) && n.coefficient > 0;

export const score = (n: ValidGrade): number => (n.value / n.outOf) * 20;

const paired = <T extends Gradable>(n: ValidGrade<T>): n is PairedGrade<T> => finite(n.classAverage);
const classScore = (n: PairedGrade<Gradable>): number => (n.classAverage / n.outOf) * 20;
const time = (n: Gradable): number => Date.parse(n.date ?? '');

/**
 * Moyenne pondérée par coefficient des notes valides ; `field` choisit la valeur
 * moyennée (note sur 20 par défaut). `null` si aucune note n'est exploitable.
 */
export function mean<T extends Gradable>(
  notes: readonly T[],
  field: (n: ValidGrade<T>) => number = score,
): number | null {
  let sum = 0;
  let weights = 0;
  for (const n of notes.filter(valid)) {
    const v = field(n);
    if (Number.isFinite(v)) {
      sum += v * n.coefficient;
      weights += n.coefficient;
    }
  }
  return weights ? sum / weights : null;
}

/**
 * Indicateurs d'une carte élève ou matière.
 * - `trend` : moyenne des `days` derniers jours moins celle des `days` jours
 *   précédents (fenêtres consécutives se terminant ce soir à minuit) ; `null` si
 *   l'une des deux fenêtres est vide.
 * - `gap` / `classAverage` : calculés uniquement sur les notes qui ont une moyenne
 *   de classe, pour comparer des ensembles identiques.
 */
export function metrics(notes: readonly Gradable[], now = new Date(), days = 30): Metrics {
  // Fin de journée dans le fuseau d'exécution (navigateur), pour inclure les notes du jour.
  const today = new Date(now);
  today.setHours(23, 59, 59, 999);
  const end = today.getTime();
  const cut = end - days * 86400000;
  const begin = cut - days * 86400000;
  const eligible = notes.filter(valid);
  const recent = eligible.filter((n) => time(n) > cut && time(n) <= end);
  const previous = eligible.filter((n) => time(n) > begin && time(n) <= cut);
  const a = mean(recent);
  const b = mean(previous);
  const pairs = eligible.filter(paired);
  return {
    average: mean(eligible),
    trend: a !== null && b !== null ? a - b : null,
    recentCount: recent.length,
    previousCount: previous.length,
    gap: mean(pairs, (n) => score(n) - classScore(n)),
    classAverage: mean(pairs, classScore),
    pairedCount: pairs.length,
    count: eligible.length,
  };
}

/** Regroupe les notes par `subjectId` (une sous-matière forme son propre groupe), triées par libellé. */
export function subjectGroups<T extends { subjectId?: string; subject: string }>(
  notes: readonly T[],
): SubjectGroup<T>[] {
  const map = new Map<string, SubjectGroup<T>>();
  for (const n of notes) {
    const k = n.subjectId || n.subject;
    let group = map.get(k);
    if (!group) {
      group = { id: k, label: n.subject, notes: [] };
      map.set(k, group);
    }
    group.notes.push(n);
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label, 'fr'));
}

/**
 * Indique si un libellé de classe désigne le collège ou le lycée.
 * Le libellé est d'abord normalisé (sans accents, en majuscules). Les classes de
 * maternelle et d'élémentaire sont exclues en premier, car « CE2 » ou « PS »
 * pourraient sinon ressembler à une abréviation. Sont ensuite reconnus les
 * niveaux en toutes lettres et les abréviations usuelles : « 6E », « 4EME B »,
 * « 2NDE », « 1ERE », « TLE », « TERM »…
 */
export function isSecondary(className: string | null | undefined = ''): boolean {
  const label = String(className)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();
  if (
    /MATERNELLE|ELEMENTAIRE|PRIMAIRE|COURS MOYEN|COURS PREPARATOIRE|\b(?:CP|CE[12]?|CM[12]?|TPS|PS|MS|GS)\b/.test(label)
  )
    return false;
  return (
    /\b(?:SIXIEME|CINQUIEME|QUATRIEME|TROISIEME|SECONDE|PREMIERE|TERMINALE|COLLEGE|LYCEE)\b/.test(label) ||
    /^(?:[3456]\s*(?:EME|E|°|È)?|2\s*(?:NDE|DE|D)|1\s*(?:ERE|RE)|T(?:LE|ER|ERM)?)(?:\b|[A-Z0-9])/.test(label)
  );
}

/**
 * N'accepte que les photos HTTPS hébergées par ecoledirecte.com (URL `//…`
 * complétée en HTTPS). Toute autre URL est rejetée, ce qui respecte la CSP
 * `img-src` du serveur et empêche de pister la famille via une image tierce.
 */
export function photoUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.startsWith('//') ? 'https:' + value : value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    return url.hostname === 'ecoledirecte.com' || url.hostname.endsWith('.ecoledirecte.com') ? url.href : null;
  } catch {
    return null;
  }
}

/** Couleur d'une note : ≥ 14/20 bonne, ≥ 10/20 moyenne, sinon faible ; neutre si non chiffrée. */
export function gradeBand(note: Gradable): GradeBand {
  if (!finite(note.value) || !finite(note.outOf) || note.outOf <= 0 || note.excluded) return 'neutral';
  const normalized = (note.value / note.outOf) * 20;
  return normalized >= 14 ? 'good' : normalized >= 10 ? 'average' : 'poor';
}

export function toTwenty(value: number | null | undefined, outOf: number | null | undefined): number | null {
  return finite(value) && finite(outOf) && outOf > 0 ? (value / outOf) * 20 : null;
}

/** Jour civil à Paris au format `YYYY-MM-DD` (la locale `en-CA` produit justement ce format). */
export function parisDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Heure (0-23) à Paris. Ne pas analyser une heure formatée en français (« 18 h »). */
export function parisHour(now: Date): number {
  const part = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Paris' })
    .formatToParts(now)
    .find((p) => p.type === 'hour');
  return Number(part?.value ?? 0) % 24;
}

/**
 * Prochain jour ouvré (lundi à vendredi) après aujourd'hui à Paris. Les vacances
 * et jours fériés ne sont pas connus. Midi UTC sert d'ancre : ajouter des jours ne
 * change jamais de date à cause d'un passage à l'heure d'été.
 */
export function nextSchoolDay(now = new Date()): string {
  const day = new Date(parisDate(now) + 'T12:00:00Z');
  do {
    day.setUTCDate(day.getUTCDate() + 1);
  } while ([0, 6].includes(day.getUTCDay()));
  return day.toISOString().slice(0, 10);
}

/**
 * Points de la courbe d'évolution, un par jour ayant au moins une note (aucun
 * ordre artificiel entre les évaluations d'un même jour). Pour chaque jour :
 * - `average` / `classAverage` : moyennes cumulées depuis le début jusqu'à ce jour ;
 * - `trend` : moyenne glissante sur les `days` jours qui se terminent ce jour-là, publiée seulement
 *   avec au moins deux notes dans la fenêtre pour éviter une courbe en dents de scie.
 */
export function gradeTimeline<T extends Gradable>(notes: readonly T[], days = 30): TimelinePoint<T>[] {
  const dated = (n: T): n is DatedGrade<T> =>
    valid(n) && /^\d{4}-\d{2}-\d{2}/.test(n.date || '') && Number.isFinite(Date.parse(n.date as string));
  const eligible = notes.filter(dated).sort((a, b) => a.date.localeCompare(b.date));
  return [...new Set(eligible.map((n) => n.date.slice(0, 10)))].map((date) => {
    const daily = eligible.filter((n) => n.date.slice(0, 10) === date);
    const end = Date.parse(date + 'T23:59:59.999Z');
    const start = end - days * 86400000;
    const rolling = eligible.filter((n) => Date.parse(n.date) > start && Date.parse(n.date) <= end);
    const accumulated = eligible.filter((n) => n.date.slice(0, 10) <= date);
    return {
      date,
      time: Date.parse(date + 'T12:00:00Z'),
      notes: daily,
      average: mean(accumulated),
      classAverage: mean(accumulated.filter(paired), classScore),
      trend: rolling.length >= 2 ? mean(rolling) : null,
      count: rolling.length,
    };
  });
}

/**
 * Notes des sept derniers jours à Paris (aujourd'hui compris) : les trois plus
 * récentes pour l'aperçu, et le total pour le badge.
 */
export function weeklyNotes<T extends Gradable>(notes: readonly T[], now = new Date()) {
  const end = parisDate(now);
  const startDate = new Date(end + 'T12:00:00Z');
  startDate.setUTCDate(startDate.getUTCDate() - 6);
  const start = startDate.toISOString().slice(0, 10);
  const all = notes
    .filter(
      (n): n is DatedGrade<T> =>
        valid(n) && typeof n.date === 'string' && n.date.slice(0, 10) >= start && n.date.slice(0, 10) <= end,
    )
    .sort((a, b) => b.date.localeCompare(a.date));
  return { notes: all.slice(0, 3), total: all.length, start, end };
}

/**
 * Clé stable d'une note pour un élève : l'identifiant ÉcoleDirecte s'il existe,
 * sinon date, matière et intitulé. Sert aux repères « nouvelle note ».
 */
export function noteKey(
  childId: string,
  note: { id?: number | string | undefined; date?: string | undefined; subjectId?: string; title?: string },
): string {
  return note.id !== undefined && note.id !== ''
    ? `${childId}|${note.id}`
    : `${childId}|${note.date ?? ''}|${note.subjectId ?? ''}|${note.title ?? ''}`;
}

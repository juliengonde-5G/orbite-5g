/**
 * Mise en forme française des notes, moyennes et dates (jours civils à Paris).
 */
import { nextSchoolDay, parisDate } from '../shared/metrics.ts';

const num1 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const num2 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });

export const average = (v: number | null | undefined): string => (v == null ? '–' : num1.format(v));
export const grade = (v: number | null | undefined): string => (v == null ? '–' : num2.format(v));

export function signed(v: number | null | undefined): string {
  if (v == null) return '';
  const r = Math.round(v * 10) / 10;
  return (r > 0 ? '+' : r < 0 ? '−' : '±') + num1.format(Math.abs(r));
}

const dayFmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const shortFmt = new Intl.DateTimeFormat('fr-FR', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const weekdayFmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', timeZone: 'UTC' });

const atNoon = (date: string) => new Date(date.slice(0, 10) + 'T12:00:00Z');

function daysFromToday(date: string, now = new Date()): number {
  return Math.round((atNoon(date).getTime() - atNoon(parisDate(now)).getTime()) / 86400000);
}

/** « Aujourd'hui », « Demain », « Lundi » (semaine en cours) ou date courte. */
export function relativeDay(date: string, now = new Date()): string {
  const d = daysFromToday(date, now);
  if (d === 0) return 'Aujourd’hui';
  if (d === 1) return 'Demain';
  if (d === -1) return 'Hier';
  if (d > 1 && d < 7) return capitalize(weekdayFmt.format(atNoon(date)));
  if (d < -1 && d > -7) return capitalize(weekdayFmt.format(atNoon(date))) + ' dernier';
  return capitalize(shortFmt.format(atNoon(date)));
}

export const longDay = (date: string): string => dayFmt.format(atNoon(date));
export const shortDay = (date: string): string => shortFmt.format(atNoon(date));
export const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Prochain jour de classe : aujourd'hui avant 16 h en semaine, sinon le jour ouvré suivant. */
export function dueFocus(now = new Date()): string {
  return nextSchoolDay(now);
}

export function greeting(name: string, now = new Date()): string {
  const hour = Number(
    new Intl.DateTimeFormat('fr-FR', { hour: 'numeric', hour12: false, timeZone: 'Europe/Paris' }).format(now),
  );
  return `${hour >= 18 || hour < 5 ? 'Bonsoir' : 'Bonjour'} ${name}`;
}

export function sinceText(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return 'jamais';
  const minutes = Math.round((now.getTime() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(minutes)) return 'inconnu';
  if (minutes < 1) return 'à l’instant';
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  return `le ${shortDay(iso.slice(0, 10))}`;
}

/** Couleur stable d'une matière (teinte dérivée de son nom). */
export function subjectHue(subject: string): number {
  let h = 0;
  for (const c of subject.toUpperCase()) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export const initial = (name: string): string => name.trim().charAt(0).toUpperCase() || '?';

const ACCENTS: Record<string, string> = {
  mathematiques: 'mathématiques',
  francais: 'français',
  geographie: 'géographie',
  education: 'éducation',
  theatre: 'théâtre',
  economiques: 'économiques',
  economie: 'économie',
  litterature: 'littérature',
  specialite: 'spécialité',
  numerique: 'numérique',
  ecrit: 'écrit',
  ecrite: 'écrite',
  etude: 'étude',
  modernes: 'modernes',
  sante: 'santé',
  societe: 'société',
  communaute: 'communauté',
  europeenne: 'européenne',
};

/** Matière en casse de phrase, accents rétablis (« HISTOIRE-GEOGRAPHIE » devient « Histoire-géographie »). */
export function subjectLabel(subject: string): string {
  if (subject !== subject.toUpperCase()) return subject;
  return subject
    .toLowerCase()
    .replace(/\p{L}+/gu, (w) => ACCENTS[w] ?? w)
    .replace(/(^|·\s*)(\p{L})/gu, (_, sep: string, letter: string) => sep + letter.toUpperCase())
    .replace(/\b(lv\d|eps|svt|emc|ses|nsi|snt|llce|hggsp|dnl)\b/gi, (m) => m.toUpperCase());
}

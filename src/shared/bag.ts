/**
 * Préparation du cartable : quel jour préparer, et quoi mettre dans le sac.
 *
 * Fonctions pures, communes au serveur (calcul de la liste) et au navigateur.
 * La liste vient des cours du jour (hors cours annulés et permanences), d'un
 * matériel par matière proposé par défaut et modifiable par la famille, du
 * matériel de tous les jours, et des pièces jointes des devoirs à rendre.
 */
import { nextSchoolDay, parisDate, parisHour } from './metrics.ts';
import type { BagItem, Course, Homework, Kit } from './types.ts';

/** Clé stable d'une matière : sans accents, en majuscules, espaces réduits. */
export function subjectKey(subject: string): string {
  return subject
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

const RULES: [RegExp, string[]][] = [
  [/SPORT|\bEPS\b|PHYSIQUE ET SPORT|ED PHYSIQUE/, ['Tenue de sport', 'Baskets', 'Gourde']],
  [/MATH/, ['Cahier de maths', 'Calculatrice', 'Règle, équerre et compas']],
  [/PHYSIQUE|CHIMIE/, ['Cahier de physique-chimie', 'Calculatrice']],
  [/\bSVT\b|VIE ET DE LA TERRE/, ['Cahier de SVT']],
  [/TECHNO/, ['Classeur de technologie']],
  [/FRANC/, ['Cahier de français', 'Livre de lecture en cours']],
  [/ANGL/, ['Cahier d’anglais']],
  [/ESPAG/, ['Cahier d’espagnol']],
  [/ALLEM/, ['Cahier d’allemand']],
  [/ITAL/, ['Cahier d’italien']],
  [/LATIN/, ['Cahier de latin']],
  [/HIST|GEO|\bEMC\b|MORAL/, ['Cahier d’histoire-géographie']],
  [/ARTS? PLAST/, ['Cahier et matériel d’arts plastiques']],
  [/MUSI/, ['Cahier de musique']],
];

/** Matériel proposé pour une matière tant que la famille ne l'a pas modifié. */
export function defaultItems(subject: string): string[] {
  const key = subjectKey(subject);
  const rule = RULES.find(([re]) => re.test(key));
  if (rule) return rule[1];
  const label = subject.trim().toLowerCase();
  return label ? [`Affaires de ${label}`] : [];
}

export const DEFAULT_ALWAYS = ['Trousse complète', 'Agenda', 'Carnet de correspondance'];

export function emptyKit(): Kit {
  return { always: [...DEFAULT_ALWAYS], subjects: {} };
}

const slug = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

/** Cours qui demandent des affaires : ni annulés, ni permanences, ni cours dont l'élève est dispensé. */
export function bagCourses(courses: readonly Course[]): Course[] {
  return courses.filter((c) => !c.cancelled && c.kind !== 'permanence' && c.kind !== 'conge' && !c.exempted);
}

/**
 * Liste du sac pour un jour. Un même objet (« Calculatrice » en maths et en
 * physique) n'apparaît qu'une fois, rattaché à la première matière de la journée.
 */
export function bagItems(courses: readonly Course[], homework: readonly Homework[], kit: Kit): BagItem[] {
  const items: BagItem[] = [];
  const seen = new Set<string>();
  const add = (label: string, subject: string | null) => {
    const clean = label.trim();
    const id = slug(clean);
    if (!clean || !id || seen.has(id)) return;
    seen.add(id);
    items.push({ id, label: clean, subject });
  };
  const subjects: string[] = [];
  for (const c of bagCourses(courses)) {
    const key = subjectKey(c.subject);
    if (!subjects.some((s) => subjectKey(s) === key)) subjects.push(c.subject);
  }
  for (const subject of subjects) {
    const custom = kit.subjects[subjectKey(subject)];
    for (const label of custom ?? defaultItems(subject)) add(label, subject);
  }
  for (const h of homework) for (const doc of h.documents) add(doc, h.subject);
  for (const label of kit.always) add(label, null);
  return items;
}

/**
 * Jour à préparer : aujourd'hui jusqu'à 16 h un jour de classe, sinon le jour
 * de classe suivant (on prépare son sac la veille au soir). Les vacances ne
 * sont pas connues : un emploi du temps vide le signalera.
 */
export function bagDate(now = new Date()): { date: string; focus: 'today' | 'next' } {
  const today = parisDate(now);
  const weekday = new Date(today + 'T12:00:00Z').getUTCDay();
  const hour = parisHour(now);
  if (weekday !== 0 && weekday !== 6 && hour < 16) return { date: today, focus: 'today' };
  return { date: nextSchoolDay(now), focus: 'next' };
}

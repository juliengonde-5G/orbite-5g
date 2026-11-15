/**
 * Page Compétences : vue d'ensemble par matière et profil d'apprentissage d'un élève.
 *
 * Rôle : transformer les évaluations ÉcoleDirecte (compétences notées de 1 à 4) et le travail
 * fait dans Orbite en une vue lisible par matière (`overviewOf`), et en un portrait chiffré de
 * l'élève (`profileOf`) qui sert à adapter les fiches de travail.
 *
 * Principes :
 * - toutes les matières évaluées apparaissent ; seules maths, français et anglais ont des fiches ;
 * - le niveau d'une compétence reste celui d'ÉcoleDirecte, le travail fait ici nuance son statut ;
 * - le profil ne contient que des mesures (niveau, moyenne, tendance, réussite, rythme) et des aides
 *   choisies par un parent : jamais de prénom, d'identifiant ni de diagnostic.
 *
 * Logique pure, sans entrée-sortie.
 */
import { metrics, parisDate } from './metrics.ts';
import {
  AIDS,
  focusesOf,
  isYoungLevel,
  levelOf,
  shiftDay,
  skillStatus,
  slug,
  subjectOf,
  type Focus,
  type SupportChild,
  type SupportSubject,
} from './support.ts';
import type { Child } from './types.ts';

export interface SkillRow {
  /** Clé de compétence ; pour les trois matières du soutien, celle des fiches (`c:<matière>:<id>`). */
  key: string;
  label: string;
  /** Dernier niveau ÉcoleDirecte de 1 à 4. */
  level: 1 | 2 | 3 | 4;
  evaluated: string | null;
  /** Évolution entre les deux dernières évaluations de cette compétence. */
  progress: 'up' | 'down' | 'flat' | null;
  status: 'reprendre' | 'progres' | 'acquise';
  /** Travail fait dans Orbite ; `null` s'il n'y en a pas. */
  work: { modules: number; right: number; total: number } | null;
  /** Les fiches existent pour cette compétence (matière du soutien). */
  sheet: boolean;
}

export interface SubjectOverview {
  id: string;
  label: string;
  support: SupportSubject | null;
  /** Moyenne /20 des 30 derniers jours ; `null` sans note. */
  average: number | null;
  trend: number | null;
  notes: number;
  counts: { acquise: number; progres: number; reprendre: number };
  /** À reprendre d'abord. */
  skills: SkillRow[];
}

export interface SkillsOverview {
  subjects: SubjectOverview[];
  totals: { acquise: number; progres: number; reprendre: number };
}

const SINCE_DAYS = 120;
const ORDER = { reprendre: 0, progres: 1, acquise: 2 } as const;
const round1 = (n: number) => Math.round(n * 10) / 10;

export function overviewOf(child: Pick<Child, 'notes'>, support: SupportChild, now = new Date()): SkillsOverview {
  const today = parisDate(now);
  const since = shiftDay(today, -SINCE_DAYS);
  const recent = shiftDay(today, -30);
  const notes = child.notes.filter((n) => (n.date ?? '') >= since);
  const groups = new Map<string, { label: string; notes: typeof notes }>();
  for (const note of notes) {
    const label = (note.parentSubject || note.subject).trim();
    if (!label) continue;
    const id = label.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const g = groups.get(id) ?? { label, notes: [] };
    g.notes.push(note);
    groups.set(id, g);
  }
  const subjects: SubjectOverview[] = [...groups.entries()].map(([id, g]) => {
    const kind = subjectOf(g.label);
    const found = new Map<string, { label: string; levels: { date: string; level: 1 | 2 | 3 | 4 }[] }>();
    for (const note of g.notes) {
      for (const skill of note.skills ?? []) {
        if (skill.level === null || !skill.name.trim()) continue;
        const skillId = skill.competenceId || skill.elemId || slug(skill.name);
        const row = found.get(skillId) ?? { label: skill.name.replace(/\s+/g, ' ').trim().slice(0, 120), levels: [] };
        row.levels.push({ date: note.date ?? '', level: skill.level });
        found.set(skillId, row);
      }
    }
    const focusByKey = new Map<string, Focus>();
    if (kind)
      for (const f of focusesOf(child, now))
        if (f.subject === kind && f.source === 'competence') focusByKey.set(f.key, f);
    const skills: SkillRow[] = [...found.entries()].map(([skillId, row]) => {
      row.levels.sort((a, b) => a.date.localeCompare(b.date));
      const last = row.levels.at(-1)!;
      const before = row.levels.at(-2);
      const key = kind ? `c:${kind}:${skillId}` : `x:${id}:${skillId}`;
      const state = kind ? support.focuses[key] : undefined;
      const worked = state && state.seen > 0 ? state : null;
      return {
        key,
        label: row.label,
        level: last.level,
        evaluated: last.date || null,
        progress: before ? (last.level > before.level ? 'up' : last.level < before.level ? 'down' : 'flat') : null,
        status: skillStatus((last.level - 1) / 3, worked),
        work: worked ? { modules: worked.seen, right: worked.right, total: worked.total } : null,
        sheet: !!kind && focusByKey.has(key),
      };
    });
    skills.sort(
      (a, b) => ORDER[a.status] - ORDER[b.status] || a.level - b.level || a.label.localeCompare(b.label, 'fr'),
    );
    const m = metrics(g.notes, now, 30);
    const average = metrics(
      g.notes.filter((n) => (n.date ?? '') >= recent),
      now,
      30,
    ).average;
    const counts = { acquise: 0, progres: 0, reprendre: 0 };
    for (const s of skills) counts[s.status]++;
    return {
      id,
      label: g.label,
      support: kind,
      average: average === null ? null : round1(average),
      trend: m.trend === null ? null : round1(m.trend),
      notes: g.notes.length,
      counts,
      skills: skills.slice(0, 30),
    };
  });
  subjects.sort(
    (a, b) =>
      b.counts.reprendre - a.counts.reprendre ||
      (a.average ?? 21) - (b.average ?? 21) ||
      a.label.localeCompare(b.label, 'fr'),
  );
  const totals = { acquise: 0, progres: 0, reprendre: 0 };
  for (const s of subjects) for (const k of ['acquise', 'progres', 'reprendre'] as const) totals[k] += s.counts[k];
  return { subjects: subjects.slice(0, 16), totals };
}

/* ---------- Profil d'apprentissage ---------- */

export type Mastery = 'reprise' | 'consolidation' | 'approfondissement';

/** Portrait chiffré d'un élève pour une compétence ; sert à écrire et à reconnaître une fiche à jour. */
export interface LearnerProfile {
  level: string;
  tone: 'ludique' | 'sobre';
  mastery: Mastery;
  /** Moyenne de la matière, arrondie à l'entier ; `null` sans note. */
  average: number | null;
  direction: 'hausse' | 'baisse' | 'stable' | 'inconnue';
  /** Réussite aux modules de cette compétence, par tranche de 10 % ; `null` si rien de fait. */
  success: number | null;
  modules: number;
  /** Secondes par question, par tranche de 5 ; `null` si inconnu. */
  pace: number | null;
  aids: string[];
}

export function profileOf(
  child: Pick<Child, 'notes' | 'className'>,
  support: SupportChild,
  focus: Focus,
  now = new Date(),
): LearnerProfile {
  const state = support.focuses[focus.key];
  const mine = child.notes.filter((n) => (subjectOf(n.parentSubject) ?? subjectOf(n.subject)) === focus.subject);
  // `metrics()` ne filtre que la tendance : la moyenne se calcule sur les 30 derniers jours, comme dans la vue d'ensemble.
  const m = metrics(mine, now, 30);
  const average = metrics(
    mine.filter((n) => (n.date ?? '') >= shiftDay(parisDate(now), -30)),
    now,
    30,
  ).average;
  const success = state && state.total > 0 ? Math.round((state.right / state.total) * 10) / 10 : null;
  const mastery: Mastery =
    focus.mastery < 0.34 || (success !== null && success < 0.4)
      ? 'reprise'
      : focus.mastery >= 0.67 && (success === null || success >= 0.7)
        ? 'approfondissement'
        : 'consolidation';
  const timed = support.history.filter((h) => h.key === focus.key && h.seconds !== null && h.total > 0);
  const pace = timed.length
    ? Math.round(timed.reduce((sum, h) => sum + (h.seconds as number) / h.total, 0) / timed.length / 5) * 5
    : null;
  return {
    level: levelOf(child.className),
    tone: isYoungLevel(child.className) ? 'ludique' : 'sobre',
    mastery,
    average: average === null ? null : Math.round(average),
    direction: m.trend === null ? 'inconnue' : Math.abs(m.trend) < 0.05 ? 'stable' : m.trend > 0 ? 'hausse' : 'baisse',
    success,
    modules: state?.seen ?? 0,
    pace,
    aids: (support.aids ?? []).filter((a) => a in AIDS).sort(),
  };
}

/* ---------- Fiches et page ---------- */

export interface SheetExercise {
  consigne: string;
  indice: string;
  corrige: string;
}

export interface SheetContent {
  objectif: string;
  rappel: string[];
  guide: SheetExercise;
  autonomes: SheetExercise[];
  astuces: string[];
  encouragement: string;
}

/** Fiche telle que la reçoit le navigateur. */
export interface SheetView {
  key: string;
  subject: SupportSubject;
  label: string;
  level: string;
  /** Instant de rédaction (ms). */
  generated: number;
  /** `claude` : rédigée pour l'élève ; `secours` : construite à partir du recueil seul. */
  via: 'claude' | 'secours';
  domain: string;
  reference: string;
  content: SheetContent;
}

export interface TodoItem {
  key: string;
  subject: SupportSubject;
  label: string;
  reason: 'new' | 'due' | 'review';
  done: boolean;
}

export interface SkillsPage {
  overview: SkillsOverview;
  todo: TodoItem[];
  enabled: boolean;
  aids: string[];
  /** Aides proposables (parent seulement) : identifiant et texte. */
  aidOptions: Record<string, string> | null;
  /** Claude rédige les fiches (une clé est réglée) ; sinon, fiches de secours. */
  writing: boolean;
}

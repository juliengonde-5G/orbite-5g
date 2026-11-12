/**
 * Moteur de soutien scolaire (V2, lot 1) : logique pure, sans entrée-sortie.
 *
 * Rôle : choisir, chaque jour, au plus trois courts modules d'entraînement à
 * partir de ce que dit ÉcoleDirecte de l'élève, puis ajuster la suite selon ses
 * réponses.
 *
 * Principes (décidés par Julien, 9 nov. 2026) :
 * - un seul rythme : 1 session par jour, modules de 10 minutes, 3 modules au plus ;
 * - maîtrise « école » : elle vient uniquement des niveaux de compétences et des
 *   moyennes ÉcoleDirecte, jamais des réponses données ici ;
 * - aucune comparaison entre élèves : tout est calculé pour un seul enfant ;
 * - périmètre : maths, français, anglais ;
 * - adaptation : une bonne série espace et durcit, une série fragile ramène plus
 *   tôt et allège, sans jugement sur l'enfant.
 *
 * Fonctionnement : `focusesOf` liste les points à travailler, `planDay` choisit
 * ceux du jour (en variant les matières), `settle` met à jour la mémoire de
 * l'élève après un module (boîtes de révision espacée de type Leitner).
 *
 * Points d'attention : les dates sont des jours civils à Paris (`YYYY-MM-DD`) ;
 * ce fichier ne dépend ni de Node ni du DOM.
 */
import { metrics, parisDate } from './metrics.ts';
import type { Child } from './types.ts';

export type SupportSubject = 'maths' | 'francais' | 'anglais';

export const SUPPORT_SUBJECTS: readonly SupportSubject[] = ['maths', 'francais', 'anglais'];
export const SUBJECT_LABEL: Record<SupportSubject, string> = {
  maths: 'Maths',
  francais: 'Français',
  anglais: 'Anglais',
};
export const MODULE_MINUTES = 10;
export const MAX_MODULES_PER_DAY = 3;
export const ITEMS_PER_MODULE = 5;
/** Délai de retour (en jours) selon la boîte : 0 = demain, 5 = dans un mois. */
export const BOX_DAYS = [1, 2, 4, 7, 14, 30] as const;

export type Difficulty = 1 | 2 | 3;

/** Un point à travailler, tel que ÉcoleDirecte le laisse voir. */
export interface Focus {
  /** `c:<compétence>` ou `s:<matière>` : stable d'un jour à l'autre. */
  key: string;
  subject: SupportSubject;
  label: string;
  /** Maîtrise « école » de 0 à 1. */
  mastery: number;
  source: 'competence' | 'matiere';
}

/** Ce que l'on sait d'un point de travail pour un élève. */
export interface FocusState {
  box: number;
  due: string;
  difficulty: Difficulty;
  seen: number;
  right: number;
  total: number;
  last: string;
}

export interface ModuleRecord {
  date: string;
  key: string;
  subject: SupportSubject;
  right: number;
  total: number;
  seconds: number | null;
  /** Heure de Paris (0-23) à laquelle le module a été terminé. */
  hour: number;
}

export interface SupportChild {
  enabled: boolean;
  focuses: Record<string, FocusState>;
  /** Derniers modules terminés, du plus ancien au plus récent (120 au plus). */
  history: ModuleRecord[];
}

export const emptySupport = (): SupportChild => ({ enabled: false, focuses: {}, history: [] });

const fold = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Maths, français ou anglais d'après le libellé de matière ; `null` pour tout le reste. */
export function subjectOf(label: string | undefined): SupportSubject | null {
  if (!label) return null;
  const text = fold(label);
  if (/\bmath/.test(text)) return 'maths';
  if (/\b(francais|lettres)\b/.test(text)) return 'francais';
  if (/\b(anglais|english)\b/.test(text)) return 'anglais';
  return null;
}

/** Niveau de classe en clair (« 6e », « 3e »), ou « secondaire » si le libellé n'est pas reconnu. */
export function levelOf(className: string | undefined): string {
  const m = /^\s*([3-6])\s*(?:e|è|eme|ème)?/i.exec(className ?? '');
  return m ? `${m[1]}e` : 'secondaire';
}

export const shiftDay = (date: string, days: number): string =>
  new Date(Date.parse(date + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);

const slug = (text: string) =>
  fold(text)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

/**
 * Points à travailler d'un élève : compétences non acquises relevées par ÉcoleDirecte
 * (dernier niveau connu de chacune) et, pour chaque matière du périmètre, une
 * révision générale d'après sa moyenne des quatre derniers mois.
 */
export function focusesOf(child: Pick<Child, 'notes'>, now = new Date()): Focus[] {
  const out = new Map<string, Focus & { when: string }>();
  for (const note of child.notes) {
    const subject = subjectOf(note.parentSubject) ?? subjectOf(note.subject);
    if (!subject) continue;
    for (const skill of note.skills ?? []) {
      if (skill.level === null || !skill.name.trim()) continue;
      const id = skill.competenceId || skill.elemId || slug(skill.name);
      if (!id) continue;
      const key = `c:${subject}:${id}`;
      const when = note.date ?? '';
      const known = out.get(key);
      if (known && known.when > when) continue;
      out.set(key, {
        key,
        subject,
        label: skill.name.replace(/\s+/g, ' ').trim().slice(0, 120),
        mastery: (skill.level - 1) / 3,
        source: 'competence',
        when,
      });
    }
  }
  const focuses: Focus[] = [...out.values()].map(({ when: _when, ...focus }) => focus);
  // `metrics()` n'utilise la durée que pour la tendance : la fenêtre de quatre mois se filtre ici.
  const since = shiftDay(parisDate(now), -120);
  for (const subject of SUPPORT_SUBJECTS) {
    const notes = child.notes.filter(
      (n) => (n.date ?? '') >= since && (subjectOf(n.parentSubject) ?? subjectOf(n.subject)) === subject,
    );
    const m = metrics(notes, now, 120);
    if (m.average === null || m.count < 2) continue;
    focuses.push({
      key: `s:${subject}`,
      subject,
      label: `Révisions de ${SUBJECT_LABEL[subject].toLowerCase()}`,
      mastery: Math.min(1, Math.max(0, m.average / 20)),
      source: 'matiere',
    });
  }
  return focuses;
}

/** Points retirés au score d'un point dont la matière est déjà au programme du jour. */
const VARIETY = 1;

const startDifficulty = (mastery: number): Difficulty => (mastery < 0.34 ? 1 : mastery < 0.67 ? 2 : 3);

export const difficultyOf = (focus: Focus, state: FocusState | undefined): Difficulty =>
  state?.difficulty ?? startDifficulty(focus.mastery);

export interface PlanItem {
  focus: Focus;
  difficulty: Difficulty;
  /** `new` : jamais travaillé ici ; `due` : révision arrivée à échéance. */
  reason: 'new' | 'due';
}

/**
 * Modules du jour. Un point revient quand sa révision est échue, ou tant qu'il est
 * nouveau et pas encore acquis ; les plus fragiles passent d'abord, et deux modules
 * de la même matière ne se suivent que faute d'autre choix.
 */
export function planDay(
  focuses: readonly Focus[],
  support: Pick<SupportChild, 'focuses'>,
  today: string,
  doneToday: readonly Pick<ModuleRecord, 'key' | 'subject'>[] = [],
): PlanItem[] {
  const room = MAX_MODULES_PER_DAY - doneToday.length;
  if (room <= 0) return [];
  const done = new Set(doneToday.map((m) => m.key));
  // La variété vaut pour toute la journée : une matière déjà travaillée compte comme déjà au programme.
  const doneSubjects = doneToday.map((m) => m.subject);
  const candidates: { item: PlanItem; score: number }[] = [];
  for (const focus of focuses) {
    if (done.has(focus.key)) continue;
    const state = support.focuses[focus.key];
    if (state && state.due > today) continue;
    if (!state && focus.mastery >= 0.9) continue;
    const late = state ? Math.min(14, (Date.parse(today) - Date.parse(state.due)) / 86400000) : 0;
    candidates.push({
      item: { focus, difficulty: difficultyOf(focus, state), reason: state ? 'due' : 'new' },
      score: (1 - focus.mastery) * 2 + late * 0.1 + (state ? 0 : 0.3),
    });
  }
  const picked: PlanItem[] = [];
  while (picked.length < room && candidates.length) {
    const used = new Set([...doneSubjects, ...picked.map((p) => p.focus.subject)]);
    const adjusted = (c: { item: PlanItem; score: number }) => c.score - (used.has(c.item.focus.subject) ? VARIETY : 0);
    candidates.sort((a, b) => adjusted(b) - adjusted(a) || a.item.focus.key.localeCompare(b.item.focus.key));
    picked.push(candidates.shift()!.item);
  }
  return picked;
}

/**
 * Met à jour la mémoire d'un point après un module. Au moins 80 % de bonnes
 * réponses : la révision s'espace, et un sans-faute durcit le niveau. Moins de
 * 50 % : retour dès demain, niveau allégé. Entre les deux, même rythme.
 */
export function settle(
  previous: FocusState | undefined,
  focus: Focus,
  right: number,
  total: number,
  today: string,
): FocusState {
  const base: FocusState = previous ?? {
    box: 0,
    due: today,
    difficulty: startDifficulty(focus.mastery),
    seen: 0,
    right: 0,
    total: 0,
    last: today,
  };
  const ratio = total > 0 ? right / total : 0;
  let { box, difficulty } = base;
  if (ratio >= 0.8) {
    box = Math.min(BOX_DAYS.length - 1, box + 1);
    if (ratio === 1 && difficulty < 3) difficulty = (difficulty + 1) as Difficulty;
  } else if (ratio < 0.5) {
    box = 0;
    if (difficulty > 1) difficulty = (difficulty - 1) as Difficulty;
  }
  return {
    box,
    due: shiftDay(today, BOX_DAYS[box] ?? 1),
    difficulty,
    seen: base.seen + 1,
    right: base.right + right,
    total: base.total + total,
    last: today,
  };
}

/** Résumé des quatorze derniers jours, par matière, pour un seul élève. */
export interface SupportSummary {
  days: number;
  modules: number;
  subjects: { subject: SupportSubject; modules: number; success: number | null }[];
  /** Heure de Paris où l'élève termine le plus souvent ses modules, une fois trois modules connus. */
  usualHour: number | null;
}

export function summarize(history: readonly ModuleRecord[], today: string): SupportSummary {
  const from = shiftDay(today, -13);
  const recent = history.filter((m) => m.date >= from && m.date <= today);
  const subjects = SUPPORT_SUBJECTS.map((subject) => {
    const rows = recent.filter((m) => m.subject === subject);
    const total = rows.reduce((sum, m) => sum + m.total, 0);
    return {
      subject,
      modules: rows.length,
      success: total ? rows.reduce((sum, m) => sum + m.right, 0) / total : null,
    };
  }).filter((s) => s.modules > 0);
  const hours = new Map<number, number>();
  for (const m of history.slice(-30)) hours.set(m.hour, (hours.get(m.hour) ?? 0) + 1);
  const best = [...hours].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  return { days: 14, modules: recent.length, subjects, usualHour: history.length >= 3 && best ? best[0] : null };
}

/* ---------- Contrat de l'API `/api/support*` ---------- */

export interface PlanEntry {
  key: string;
  subject: SupportSubject;
  label: string;
  difficulty: Difficulty;
  reason: 'new' | 'due';
}

export interface SupportStatus {
  enabled: boolean;
  /** Faux sans clé Claude : le soutien est alors visible mais rien ne peut être généré. */
  available: boolean;
  minutes: number;
  max: number;
  doneToday: number;
  plan: PlanEntry[];
  summary: SupportSummary;
}

export interface ModuleView {
  id: string;
  subject: SupportSubject;
  label: string;
  minutes: number;
  items: { q: string; choices: string[] }[];
}

export interface ModuleResult {
  right: number;
  total: number;
  items: { correct: boolean; answer: number; explain: string }[];
  status: SupportStatus;
}

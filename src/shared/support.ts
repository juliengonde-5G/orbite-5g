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
 * ceux du jour (en variant les matières, toujours trois tant que l'élève n'en a pas
 * déjà fait), `settle` met à jour la mémoire de l'élève après un module (boîtes de
 * révision espacée de type Leitner) et `monitorOf` prépare le suivi des parents.
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
  /** Jour de la dernière évaluation connue pour ce point (`YYYY-MM-DD`), si elle existe. */
  evaluated?: string;
  /** Moyenne /20 réelle de la matière (notes ÉcoleDirecte), pour une révision générale ; absente sans note. */
  average?: number;
  /** Point faible d'une évaluation récente (moins de 30 jours) : il passe devant les autres. */
  urgent?: boolean;
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
  /** Plan fixé par l'audit du jour : il ne bouge plus jusqu'à demain. */
  daily: DailyPlan | null;
}

/** Résultat de l'audit quotidien d'un élève. */
export interface DailyPlan {
  date: string;
  /** Instant de l'audit (ms). */
  audited: number;
  items: PlanItem[];
  /** La notification « tes compétences du jour » est partie. */
  notified: boolean;
}

export const emptySupport = (): SupportChild => ({ enabled: false, focuses: {}, history: [], daily: null });

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
        ...(when ? { evaluated: when } : {}),
        when,
      });
    }
  }
  const today = parisDate(now);
  const recent = shiftDay(today, -30);
  const focuses: Focus[] = [...out.values()].map(({ when, ...focus }) =>
    when >= recent && focus.mastery < 0.5 ? { ...focus, urgent: true } : focus,
  );
  // `metrics()` n'utilise la durée que pour la tendance : la fenêtre de quatre mois se filtre ici.
  const since = shiftDay(today, -120);
  for (const subject of SUPPORT_SUBJECTS) {
    const notes = child.notes.filter(
      (n) => (n.date ?? '') >= since && (subjectOf(n.parentSubject) ?? subjectOf(n.subject)) === subject,
    );
    const m = metrics(notes, now, 120);
    const all = metrics(notes, now, 120);
    const known = m.average !== null && m.count >= 2;
    const lastNote = notes.reduce((d, n) => ((n.date ?? '') > d ? (n.date ?? '') : d), '');
    const weak = metrics(
      notes.filter((n) => (n.date ?? '') >= recent),
      now,
      30,
    ).average;
    // Sans assez de notes, la révision générale reste proposée à un niveau moyen : il y a toujours trois points.
    focuses.push({
      key: `s:${subject}`,
      subject,
      label: `Révisions de ${SUBJECT_LABEL[subject].toLowerCase()}`,
      mastery: known ? Math.min(1, Math.max(0, (m.average as number) / 20)) : 0.5,
      source: 'matiere',
      ...(lastNote ? { evaluated: lastNote } : {}),
      ...(all.average !== null ? { average: all.average } : {}),
      ...(weak !== null && weak < 10 ? { urgent: true } : {}),
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
  reason: 'new' | 'due' | 'review';
}

/**
 * Modules du jour. Un point revient quand sa révision est échue, ou tant qu'il est
 * nouveau et pas encore acquis ; les plus fragiles passent d'abord (un point faible
 * d'une évaluation récente passe devant), et deux modules de la même matière ne se
 * suivent que faute d'autre choix. S'il reste de la place, elle est complétée par les
 * points les moins acquis (« révision ») : un élève a toujours trois compétences par jour.
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
  const spare: { item: PlanItem; score: number }[] = [];
  for (const focus of focuses) {
    if (done.has(focus.key)) continue;
    const state = support.focuses[focus.key];
    const base = (1 - focus.mastery) * 2 + (focus.urgent ? 0.6 : 0);
    if ((state && state.due > today) || (!state && focus.mastery >= 0.9)) {
      spare.push({ item: { focus, difficulty: difficultyOf(focus, state), reason: 'review' }, score: base });
      continue;
    }
    const late = state ? Math.min(14, (Date.parse(today) - Date.parse(state.due)) / 86400000) : 0;
    candidates.push({
      item: { focus, difficulty: difficultyOf(focus, state), reason: state ? 'due' : 'new' },
      score: base + late * 0.1 + (state ? 0 : 0.3),
    });
  }
  const picked: PlanItem[] = [];
  for (const pool of [candidates, spare]) {
    while (picked.length < room && pool.length) {
      const used = new Set([...doneSubjects, ...picked.map((p) => p.focus.subject)]);
      const adjusted = (c: { item: PlanItem; score: number }) =>
        c.score - (used.has(c.item.focus.subject) ? VARIETY : 0);
      pool.sort((a, b) => adjusted(b) - adjusted(a) || a.item.focus.key.localeCompare(b.item.focus.key));
      picked.push(pool.shift()!.item);
    }
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
  reason: 'new' | 'due' | 'review';
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

/* ---------- Suivi des parents ---------- */

export interface SkillMonitor {
  key: string;
  subject: SupportSubject;
  label: string;
  source: Focus['source'];
  /** Niveau ÉcoleDirecte de 1 à 4 pour une compétence ; `null` pour une révision générale (moyenne). */
  level: 1 | 2 | 3 | 4 | null;
  /** Moyenne /20 pour une révision générale ; `null` pour une compétence. */
  average: number | null;
  /** Jour de la dernière évaluation connue. */
  evaluated: string | null;
  /** Travail complémentaire fait dans Orbite ; `null` si rien n'a encore été travaillé. */
  work: { modules: number; right: number; total: number; success: number | null; next: string; last: string } | null;
  /** `reprendre` : à retravailler ; `progres` : en cours ; `acquise` : acquise à l'école. */
  status: 'reprendre' | 'progres' | 'acquise';
}

export interface SupportMonitor {
  enabled: boolean;
  /** Quatorze derniers jours, du plus ancien au plus récent. */
  days: { date: string; modules: number }[];
  /** Jours où les trois modules ont été faits. */
  fullDays: number;
  subjects: {
    subject: SupportSubject;
    average: number | null;
    trend: number | null;
    modules: number;
    success: number | null;
  }[];
  /** Les points les moins acquis d'abord. */
  skills: SkillMonitor[];
  /** Plan du jour fixé par l'audit (libellés seulement). */
  today: { subject: SupportSubject; label: string; done: boolean }[];
}

/**
 * Suivi d'un seul enfant : ce que disent ses évaluations ÉcoleDirecte, et ce que
 * le travail complémentaire a donné. La maîtrise « école » reste celle d'ÉcoleDirecte :
 * le travail ici nuance le statut d'un point, il ne le remplace pas.
 */
export function monitorOf(
  child: Pick<Child, 'notes'>,
  support: SupportChild,
  today: string,
  now = new Date(),
): SupportMonitor {
  const focuses = focusesOf(child, now);
  const skills: SkillMonitor[] = focuses.map((focus) => {
    const state = support.focuses[focus.key];
    const modules = support.history.filter((m) => m.key === focus.key);
    const level = focus.source === 'competence' ? ((Math.round(focus.mastery * 3) + 1) as 1 | 2 | 3 | 4) : null;
    const worked = state && state.seen > 0 ? state : null;
    const success = worked && worked.total > 0 ? worked.right / worked.total : null;
    const consolidated = !!worked && worked.seen >= 3 && success !== null && success >= 0.8;
    const status: SkillMonitor['status'] =
      // Niveau 3 (« satisfaisante ») = 2/3 : on arrondit avant de comparer pour qu'il compte comme acquis.
      Math.round(focus.mastery * 1000) / 1000 >= 0.667
        ? 'acquise'
        : focus.mastery < 0.5 && !consolidated
          ? 'reprendre'
          : 'progres';
    return {
      key: focus.key,
      subject: focus.subject,
      label: focus.label,
      source: focus.source,
      level,
      average: focus.average === undefined ? null : Math.round(focus.average * 10) / 10,
      evaluated: focus.evaluated ?? null,
      work: worked
        ? {
            modules: worked.seen,
            right: worked.right,
            total: worked.total,
            success,
            next: worked.due,
            last: modules.at(-1)?.date ?? worked.last,
          }
        : null,
      status,
    };
  });
  const order = { reprendre: 0, progres: 1, acquise: 2 } as const;
  skills.sort(
    (a, b) =>
      order[a.status] - order[b.status] ||
      (a.level ?? 4) - (b.level ?? 4) ||
      (a.average ?? 20) - (b.average ?? 20) ||
      a.key.localeCompare(b.key),
  );
  const days = Array.from({ length: 14 }, (_, i) => {
    const date = shiftDay(today, i - 13);
    return { date, modules: support.history.filter((m) => m.date === date).length };
  });
  const summary = summarize(support.history, today);
  const since = shiftDay(today, -120);
  const subjects = SUPPORT_SUBJECTS.map((subject) => {
    const mine120 = child.notes.filter(
      (n) => (n.date ?? '') >= since && (subjectOf(n.parentSubject) ?? subjectOf(n.subject)) === subject,
    );
    // La moyenne affichée porte sur 30 jours ; la tendance garde l'historique dont elle a besoin.
    const m = metrics(mine120, now, 30);
    const average30 = metrics(
      mine120.filter((n) => (n.date ?? '') >= shiftDay(today, -30)),
      now,
      30,
    ).average;
    const mine = summary.subjects.find((s) => s.subject === subject);
    return {
      subject,
      average: average30 === null ? null : Math.round(average30 * 10) / 10,
      trend: m.trend === null ? null : Math.round(m.trend * 10) / 10,
      modules: mine?.modules ?? 0,
      success: mine?.success ?? null,
    };
  });
  const done = new Set(support.history.filter((m) => m.date === today).map((m) => m.key));
  const planned =
    support.daily?.date === today
      ? support.daily.items.map((p) => ({
          subject: p.focus.subject,
          label: p.focus.label,
          done: done.has(p.focus.key),
        }))
      : [];
  return {
    enabled: support.enabled,
    days,
    fullDays: days.filter((d) => d.modules >= MAX_MODULES_PER_DAY).length,
    subjects,
    skills: skills.slice(0, 40),
    today: planned,
  };
}

/* ---------- Messages aux élèves ---------- */

/** Les plus jeunes (6e, 5e) reçoivent un ton plus joueur ; les autres, plus sobre. */
export const isYoungLevel = (className: string | undefined): boolean => /^(6|5)e$/.test(levelOf(className));

const subjectsText = (subjects: readonly SupportSubject[]): string => {
  const names = [...new Set(subjects)].map((s) => SUBJECT_LABEL[s]);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} et ${names.at(-1)}` : (names[0] ?? '');
};

/** Notification envoyée à l'élève quand un parent active le soutien. */
export function activationMessage(name: string, className: string | undefined): { title: string; body: string } {
  return isYoungLevel(className)
    ? {
        title: `${name}, ton entraînement est prêt !`,
        body: `Chaque jour, 3 petits défis de ${MODULE_MINUTES} minutes en maths, français et anglais, choisis pour toi. On essaie ?`,
      }
    : {
        title: 'Soutien activé',
        body: `Chaque jour, ${MAX_MODULES_PER_DAY} modules de ${MODULE_MINUTES} minutes ciblés sur les points à consolider. À faire quand ça t’arrange.`,
      };
}

/** Notification du matin : les trois compétences du jour. */
export function dailyMessage(
  name: string,
  className: string | undefined,
  items: readonly Pick<PlanItem, 'focus'>[],
): { title: string; body: string } {
  const text = subjectsText(items.map((p) => p.focus.subject));
  return isYoungLevel(className)
    ? {
        title: `${name}, tes ${items.length} défis du jour`,
        body: `${text} : ${MODULE_MINUTES} minutes chacun, dans l’ordre que tu veux.`,
      }
    : {
        title: 'Ton entraînement du jour',
        body: `${items.length} compétences à travailler : ${text}.`,
      };
}

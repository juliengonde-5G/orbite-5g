/**
 * État partagé de l'interface. Les vues lisent cet objet ; `app.ts` le modifie
 * puis demande un nouveau rendu (`render`).
 */
import type { BagDay, FamilyDashboard, Homework, HomeworkDate, MemberView, SessionInfo } from '../shared/types.ts';

export type Route = 'home' | 'child' | 'bag' | 'tasks' | 'grades' | 'progress' | 'me';

export interface HomeworkState {
  items: Homework[];
  dates: HomeworkDate[];
  next: number | null;
  partial: boolean;
  loaded: boolean;
  loading: boolean;
  moreLoading: boolean;
  error: string | null;
}

export interface BagState {
  day: BagDay | null;
  loading: boolean;
  error: string | null;
}

export interface CoachingState {
  text: string | null;
  loading: boolean;
  failed: boolean;
}

export const state = {
  session: null as SessionInfo | null,
  /** Profils complets (parents seulement) : couleurs et rattachements des élèves. */
  members: [] as MemberView[],
  data: null as FamilyDashboard | null,
  dataTime: 0,
  dataLoading: false,
  dataError: null as string | null,
  homework: new Map<string, HomeworkState>(),
  coaching: new Map<string, CoachingState>(),
  /** Cartable par élève et par jour (`élève|date`, ou `élève|auto` pour le jour proposé). */
  bags: new Map<string, BagState>(),
  /** Jour choisi dans l'écran Cartable ; `null` = jour proposé automatiquement. */
  bagDay: null as string | null,
  /** Élève affiché dans les onglets Devoirs, Notes et Progrès (parents). */
  selected: null as string | null,
  route: 'home' as Route,
  notesMode: 'recent' as 'recent' | 'subjects',
  period: 'all',
  openSubject: null as string | null,
  openTask: null as string | null,
  fresh: new Set<string>(),
  seenSent: false,
};

export function resetData(): void {
  state.data = null;
  state.dataTime = 0;
  state.dataError = null;
  state.homework.clear();
  state.coaching.clear();
  state.bags.clear();
  state.bagDay = null;
  state.fresh.clear();
  state.selected = null;
  state.members = [];
  state.seenSent = false;
}

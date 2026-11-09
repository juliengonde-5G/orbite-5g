/**
 * État partagé de l'interface. Les vues lisent cet objet ; `app.ts` le modifie
 * puis demande un nouveau rendu (`render`).
 */
import type { FamilyDashboard, Homework, HomeworkDate, MemberView, SessionInfo } from '../shared/types.ts';

export type Route = 'home' | 'child' | 'tasks' | 'grades' | 'progress' | 'me';

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
  state.fresh.clear();
  state.selected = null;
  state.members = [];
  state.seenSent = false;
}

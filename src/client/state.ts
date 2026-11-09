/**
 * État partagé de l'interface. Les vues lisent cet objet ; `app.ts` le modifie
 * puis demande un nouveau rendu (`render`).
 */
import type {
  BagDay,
  FamilyDashboard,
  Homework,
  HomeworkDate,
  MailDetail,
  MailList,
  MemberView,
  SchoolLife,
  SessionInfo,
} from '../shared/types.ts';

export type Route = 'home' | 'child' | 'bag' | 'tasks' | 'grades' | 'progress' | 'messages' | 'message' | 'life' | 'me';

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

/** Chargement générique : valeur, en cours, erreur lisible. */
export interface Loadable<T> {
  value: T | null;
  loading: boolean;
  error: string | null;
  /** Heure du dernier chargement réussi (ms). */
  time?: number;
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
  /** Boîtes de réception : `family` ou identifiant d'élève. */
  mail: new Map<string, Loadable<MailList>>(),
  /** Messages ouverts, par clé. */
  mailDetail: new Map<string, Loadable<MailDetail>>(),
  /** Boîte affichée dans l'onglet Messages (parents) : `family` ou un élève. */
  mailScope: 'family',
  /** Message affiché (route `message`). */
  mailOpen: null as string | null,
  /** Messages non lus de la boîte principale, pour la pastille de l'onglet. */
  unread: 0,
  lives: new Map<string, Loadable<SchoolLife>>(),
  /** Élève affiché dans les onglets Devoirs, Notes et Progrès (parents). */
  selected: null as string | null,
  route: 'home' as Route,
  notesMode: 'recent' as 'recent' | 'subjects' | 'progress',
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
  state.mail.clear();
  state.mailDetail.clear();
  state.lives.clear();
  state.mailScope = 'family';
  state.mailOpen = null;
  state.unread = 0;
  state.bagDay = null;
  state.fresh.clear();
  state.selected = null;
  state.members = [];
  state.seenSent = false;
}

/**
 * Notes de version et signalements (contrat commun serveur et navigateur).
 *
 * Les notes sont écrites à la main, en français simple, version après version :
 * la plus récente d'abord, comme l'historique « Nouveautés » d'une boutique
 * d'applications. Ajouter une entrée à chaque numéro de version publié
 * (un test vérifie que la première correspond à `package.json`).
 */

export interface Release {
  version: string;
  /** Jour de mise en ligne, `YYYY-MM-DD`. */
  date: string;
  title: string;
  notes: string[];
}

export const RELEASES: readonly Release[] = [
  {
    version: '1.8.0',
    date: '2026-11-15',
    title: 'Compétences : une page, des fiches sur mesure',
    notes: [
      'Un bouton Compétences dans le menu : un anneau, puis une ligne par matière avec un carré par compétence évaluée, le niveau ÉcoleDirecte et le travail fait dans Orbite.',
      'Pour chaque compétence du jour, une fiche écrite par Claude pour l’élève : rappel, exercice guidé, exercices à faire seul avec indices et corrigés masqués.',
      'Les fiches s’appuient sur un recueil des programmes du collège (maths, français, anglais) et s’adaptent à la classe, aux résultats, au rythme et aux aides choisies par un parent. Elles se mettent à jour à l’usage.',
      'Sans clé Claude, une fiche de secours tirée du programme reste disponible.',
    ],
  },
  {
    version: '1.7.1',
    date: '2026-11-15',
    title: 'Un bouton Aide dans le menu',
    notes: [
      'Les Nouveautés et le signalement d’un problème ont leur bouton « Aide » dans la barre du bas, au lieu des Réglages.',
      'Le parent administrateur y retrouve aussi les signalements reçus.',
      'Sur téléphone, seul l’onglet actif affiche son nom, pour que la barre reste lisible.',
    ],
  },
  {
    version: '1.7.0',
    date: '2026-11-15',
    title: 'Soutien scolaire : un audit chaque jour',
    notes: [
      'Chaque matin, Orbite relit les évaluations et fixe 3 compétences à travailler par enfant, en commençant par les plus faibles et les plus récentes.',
      'L’enfant reçoit une notification le matin, avec un message adapté à sa classe ; il en reçoit aussi une quand un parent active le soutien.',
      'Les parents trouvent une note qui explique le fonctionnement, et un suivi des compétences : niveau ÉcoleDirecte, travail fait ici, régularité sur 14 jours.',
    ],
  },
  {
    version: '1.6.0',
    date: '2026-11-15',
    title: 'Plusieurs familles',
    notes: [
      'Orbite peut héberger d’autres familles, chacune avec son lien, son espace chiffré et son propre compte ÉcoleDirecte.',
      'Une famille se crée sur invitation, avec un lien à usage unique, et s’installe pas à pas grâce à un assistant.',
      'La clé Claude reste unique ; chaque famille a un plafond quotidien que l’administrateur règle.',
    ],
  },
  {
    version: '1.5.0',
    date: '2026-11-15',
    title: 'Nouveautés et signalements',
    notes: [
      'Un historique des versions : ce qui change, version après version.',
      'Un bouton pour signaler un problème ou proposer une idée, depuis Moi.',
      'Le parent administrateur reçoit les signalements et les marque comme traités.',
    ],
  },
  {
    version: '1.4.0',
    date: '2026-11-15',
    title: 'Soutien scolaire',
    notes: [
      'Un entraînement par jour en maths, français et anglais : trois modules de dix minutes au plus.',
      'Les points à travailler viennent des compétences et des moyennes ÉcoleDirecte.',
      'Les révisions s’espacent quand ça va bien et reviennent plus tôt quand c’est fragile.',
      'Un parent l’active enfant par enfant ; seul l’élève répond.',
    ],
  },
  {
    version: '1.3.0',
    date: '2026-11-09',
    title: 'Notifications, documents et semaine',
    notes: [
      'Notifications sur le téléphone : nouvelle note (sans la valeur), messages, vie scolaire, rappel du cartable et récap du dimanche.',
      'Documents et bulletins pour les parents.',
      '« En classe » : ce que les professeurs ont noté pendant les cours.',
      'Moyennes officielles par matière, appréciations et date du conseil de classe, sans aucun rang.',
      'La semaine d’un coup d’œil et le récap de la semaine pour les parents.',
    ],
  },
  {
    version: '1.2.1',
    date: '2026-11-09',
    title: 'Ouverture depuis un lien',
    notes: ['L’appli s’ouvre correctement depuis un lien venu d’un autre site.'],
  },
  {
    version: '1.2.0',
    date: '2026-11-09',
    title: 'Nouveau design mobile',
    notes: [
      'Un ciel à la couleur de chaque élève et une orbite pour les résultats.',
      'Messagerie de l’établissement en lecture seule.',
      'Vie scolaire : absences, retards, punitions et encouragements.',
      'Mon cartable : cours du jour, devoirs à rendre et liste du sac.',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-11-09',
    title: 'Orbite 5G',
    notes: [
      'La version familiale d’Orbite, hébergée sur le NAS : notes, devoirs et progression.',
      'Un profil par membre de la famille, déverrouillé par un code PIN ; chaque enfant ne voit que ses résultats.',
    ],
  },
];

/** Versions parues après `seen` (sans `seen` : aucune, rien à annoncer à une première visite). */
export function releasesSince(seen: string | null, releases: readonly Release[] = RELEASES): Release[] {
  if (!seen) return [];
  const at = releases.findIndex((r) => r.version === seen);
  return at < 0 ? releases.slice(0, 1) : releases.slice(0, at);
}

export type ReportKind = 'bug' | 'idea' | 'question';
export const REPORT_KINDS: readonly ReportKind[] = ['bug', 'idea', 'question'];
export const REPORT_LABEL: Record<ReportKind, string> = {
  bug: 'Un problème',
  idea: 'Une idée',
  question: 'Une question',
};
export const REPORT_MAX = 1000;

/** Un signalement, tel que le parent administrateur le lit. */
export interface ReportView {
  id: string;
  at: number;
  by: string;
  kind: ReportKind;
  text: string;
  /** Écran ouvert au moment du signalement (`accueil`, `notes`…). */
  screen: string;
  version: string;
  done: boolean;
}

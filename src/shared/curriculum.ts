/**
 * Recueil pédagogique : repères de programme du collège pour les trois matières du soutien.
 *
 * Rôle : donner à la rédaction des fiches une base stable et vérifiable (ce qui est attendu
 * d'un élève, les erreurs fréquentes, les appuis qui marchent) plutôt que de laisser le
 * modèle improviser le programme.
 *
 * Origine : synthèse rédigée à la main d'après les programmes officiels du collège (cycle 3 pour
 * la 6e, cycle 4 pour la 5e, la 4e et la 3e) et les repères annuels de progression publiés sur
 * Éduscol. Ce sont des résumés dans nos mots, pas des extraits : à relire contre les textes
 * officiels avant de s'y fier pour autre chose qu'un entraînement. Le serveur n'a pas pu
 * télécharger les documents Éduscol (accès refusé) : rien ici n'est repris tel quel.
 *
 * Fonctionnement : `curriculumFor` retrouve l'entrée qui correspond à l'intitulé d'une compétence
 * ÉcoleDirecte (mots-clés, sans accents), sinon l'entrée « résolution de problèmes » ou générale
 * de la matière. Logique pure, sans entrée-sortie.
 */
import type { SupportSubject } from './support.ts';

export type Level = '6e' | '5e' | '4e' | '3e';

export interface CurriculumEntry {
  id: string;
  subject: SupportSubject;
  domain: string;
  /** Classes où la notion est centrale (elle peut être revue avant ou après). */
  levels: readonly Level[];
  /** Mots-clés repérés dans l'intitulé de la compétence, sans accents. */
  keywords: readonly string[];
  /** Ce que l'élève doit savoir faire, en une ou deux phrases. */
  attendu: string;
  /** Notion à retrouver d'abord quand la maîtrise est fragile. */
  prerequis: string;
  erreurs: readonly string[];
  appuis: readonly string[];
}

/** Pages officielles de référence (Éduscol). */
export const SOURCES: Record<'repères' | 'cycle4', string> = {
  repères:
    'https://eduscol.education.gouv.fr/6910/reperes-annuels-de-progression-et-attendus-de-fin-d-annee-du-cp-la-troisieme',
  cycle4: 'https://eduscol.education.gouv.fr/4362/enseigner-au-cycle-4',
};

const ALL: readonly Level[] = ['6e', '5e', '4e', '3e'];

export const CURRICULUM: readonly CurriculumEntry[] = [
  /* ---------- Mathématiques ---------- */
  {
    id: 'maths-nombres',
    subject: 'maths',
    domain: 'Nombres entiers et décimaux',
    levels: ['6e', '5e'],
    keywords: ['decimal', 'entier', 'nombre', 'arrondi', 'ecriture'],
    attendu:
      'Lire, écrire, comparer, ranger et placer sur une droite graduée des entiers et des décimaux ; calculer de tête et par écrit avec les quatre opérations.',
    prerequis: 'La valeur de chaque chiffre dans un nombre (unités, dixièmes, centièmes).',
    erreurs: [
      'Croire que 3,45 est plus grand que 3,5 parce que 45 est plus grand que 5.',
      'Mal aligner les virgules dans une addition ou une soustraction posée.',
    ],
    appuis: ['Une droite graduée où l’on place les nombres.', 'Un tableau de numération avec la virgule.'],
  },
  {
    id: 'maths-fractions',
    subject: 'maths',
    domain: 'Fractions',
    levels: ['6e', '5e', '4e'],
    keywords: ['fraction', 'quotient', 'denominateur', 'numerateur'],
    attendu:
      'Comprendre une fraction comme partage et comme quotient, comparer des fractions, les additionner, soustraire, multiplier (et diviser en 4e), simplifier.',
    prerequis: 'Partager une unité en parts égales et lire « 3 parts sur 4 ».',
    erreurs: [
      'Additionner numérateurs et dénominateurs entre eux (1/2 + 1/3 = 2/5).',
      'Croire qu’une fraction au dénominateur plus grand est plus grande.',
    ],
    appuis: ['Barres ou disques partagés en parts égales.', 'Mettre au même dénominateur avant de comparer.'],
  },
  {
    id: 'maths-relatifs',
    subject: 'maths',
    domain: 'Nombres relatifs',
    levels: ['5e', '4e'],
    keywords: ['relatif', 'negatif', 'signe', 'oppose'],
    attendu: 'Comparer, additionner et soustraire des relatifs en 5e, les multiplier et les diviser en 4e.',
    prerequis: 'Se repérer sur une droite graduée de part et d’autre de zéro.',
    erreurs: ['Oublier la règle des signes dans une soustraction.', 'Confondre −3 − 2 et −3 + 2.'],
    appuis: ['Droite graduée ou températures.', 'Transformer la soustraction en addition de l’opposé.'],
  },
  {
    id: 'maths-calcul',
    subject: 'maths',
    domain: 'Calcul numérique : priorités et puissances',
    levels: ['5e', '4e', '3e'],
    keywords: ['priorite', 'puissance', 'racine', 'calcul numerique', 'notation scientifique'],
    attendu:
      'Respecter les priorités opératoires, utiliser parenthèses, puissances et racines carrées, écrire en notation scientifique (3e).',
    prerequis: 'Les tables et le calcul mental de base.',
    erreurs: ['Calculer de gauche à droite sans respecter la multiplication prioritaire.', 'Confondre 2³ et 2 × 3.'],
    appuis: ['Entourer l’opération à faire en premier.', 'Réécrire le calcul ligne par ligne.'],
  },
  {
    id: 'maths-litteral',
    subject: 'maths',
    domain: 'Calcul littéral et équations',
    levels: ['5e', '4e', '3e'],
    keywords: ['litteral', 'equation', 'expression', 'developper', 'factoriser', 'inconnue', 'inequation', 'formule'],
    attendu:
      'Utiliser une lettre pour un nombre, réduire, développer (puis factoriser en 3e), tester une égalité, résoudre une équation du premier degré.',
    prerequis: 'Calculer la valeur d’une expression quand on remplace la lettre par un nombre.',
    erreurs: [
      'Réduire 3x + 2 en 5x.',
      'Oublier de distribuer à tous les termes d’une parenthèse.',
      'Ne pas faire la même opération des deux côtés d’une équation.',
    ],
    appuis: [
      'Remplacer la lettre par un nombre pour vérifier.',
      'La balance : ce qu’on fait à gauche, on le fait à droite.',
    ],
  },
  {
    id: 'maths-proportionnalite',
    subject: 'maths',
    domain: 'Proportionnalité et pourcentages',
    levels: ALL,
    keywords: ['proportion', 'pourcentage', 'taux', 'echelle', 'vitesse', 'ratio', 'coefficient'],
    attendu:
      'Reconnaître une situation de proportionnalité, calculer une quatrième proportionnelle, appliquer un pourcentage, utiliser une échelle ou une vitesse.',
    prerequis: 'Multiplier et diviser, passer de « pour 1 » à « pour 5 ».',
    erreurs: [
      'Penser que tout tableau avec des nombres qui augmentent est proportionnel.',
      'Calculer 20 % d’une quantité en divisant par 20.',
    ],
    appuis: ['Tableau de proportionnalité avec la ligne « pour 1 ».', '10 % = diviser par 10, puis combiner.'],
  },
  {
    id: 'maths-grandeurs',
    subject: 'maths',
    domain: 'Grandeurs et mesures',
    levels: ALL,
    keywords: ['grandeur', 'mesure', 'aire', 'perimetre', 'volume', 'unite', 'conversion', 'duree', 'longueur'],
    attendu: 'Calculer périmètres, aires et volumes usuels, convertir les unités, calculer avec des durées.',
    prerequis: 'Les unités de longueur et leurs liens (cm, m, km).',
    erreurs: ['Confondre périmètre et aire.', 'Convertir des cm² comme des cm (oublier le carré).'],
    appuis: ['Tableau de conversion avec une colonne par unité.', 'Pavages et quadrillages pour comprendre l’aire.'],
  },
  {
    id: 'maths-geometrie',
    subject: 'maths',
    domain: 'Géométrie plane',
    levels: ALL,
    keywords: [
      'geometr',
      'angle',
      'triangle',
      'parallele',
      'perpendiculaire',
      'symetrie',
      'cercle',
      'pythagore',
      'thales',
      'figure',
      'construire',
      'rectangle',
      'quadrilatere',
    ],
    attendu:
      'Reconnaître, construire et raisonner sur les figures usuelles ; symétries, angles, triangles ; Thalès et Pythagore au cycle 4.',
    prerequis: 'Utiliser règle, équerre, compas et rapporteur avec soin.',
    erreurs: [
      'Mesurer un angle sur la mauvaise graduation du rapporteur.',
      'Appliquer Pythagore sans vérifier que le triangle est rectangle.',
    ],
    appuis: ['Un schéma codé à main levée avant de construire.', 'Écrire la propriété utilisée à chaque étape.'],
  },
  {
    id: 'maths-espace',
    subject: 'maths',
    domain: 'Géométrie dans l’espace',
    levels: ALL,
    keywords: ['espace', 'solide', 'pave', 'cylindre', 'pyramide', 'cone', 'sphere', 'patron'],
    attendu: 'Reconnaître les solides, lire un patron, calculer des volumes, agrandir ou réduire.',
    prerequis: 'Nommer faces, arêtes et sommets.',
    erreurs: ['Confondre aire de base et volume.', 'Oublier une face dans un patron.'],
    appuis: [
      'Manipuler ou dessiner le patron.',
      'Prisme et cylindre : volume = aire de la base × hauteur. Pyramide et cône : un tiers de ce produit.',
    ],
  },
  {
    id: 'maths-donnees',
    subject: 'maths',
    domain: 'Statistiques et probabilités',
    levels: ALL,
    keywords: [
      'statistique',
      'probabilite',
      'moyenne',
      'mediane',
      'frequence',
      'donnee',
      'diagramme',
      'graphique',
      'tableau',
      'hasard',
      'aleatoire',
    ],
    attendu:
      'Lire et construire tableaux et graphiques, calculer moyenne, médiane, étendue et fréquences, calculer une probabilité simple.',
    prerequis: 'Lire un tableau à double entrée.',
    erreurs: ['Confondre moyenne et médiane.', 'Donner une probabilité supérieure à 1.'],
    appuis: ['Ranger les valeurs avant la médiane.', 'Une probabilité est une fraction entre 0 et 1.'],
  },
  {
    id: 'maths-fonctions',
    subject: 'maths',
    domain: 'Fonctions',
    levels: ['4e', '3e'],
    keywords: ['fonction', 'image', 'antecedent', 'affine', 'lineaire', 'courbe', 'representation graphique'],
    attendu: 'Comprendre image et antécédent, lire un graphique, calculer avec une fonction (linéaire, affine en 3e).',
    prerequis: 'Placer un point avec ses coordonnées.',
    erreurs: ['Inverser image et antécédent.', 'Lire l’axe horizontal pour l’axe vertical.'],
    appuis: ['Un tableau de valeurs avant le graphique.', 'Dire « x devient f(x) » à voix haute.'],
  },
  {
    id: 'maths-algo',
    subject: 'maths',
    domain: 'Algorithmique et programmation',
    levels: ALL,
    keywords: ['algorithm', 'programm', 'scratch', 'boucle', 'variable', 'script'],
    attendu: 'Écrire et comprendre un programme avec séquences, boucles, conditions et variables.',
    prerequis: 'Décrire une suite d’instructions dans l’ordre.',
    erreurs: ['Oublier d’initialiser une variable.', 'Se tromper sur la condition d’arrêt d’une boucle.'],
    appuis: ['Faire tourner le programme à la main sur un exemple.', 'Tester une petite partie à la fois.'],
  },
  {
    id: 'maths-problemes',
    subject: 'maths',
    domain: 'Résoudre un problème et raisonner',
    levels: ALL,
    keywords: [
      'probleme',
      'raisonner',
      'chercher',
      'modeliser',
      'communiquer',
      'representer',
      'demonstr',
      'justifier',
      'mathematique',
      'mobiliser',
    ],
    attendu:
      'Chercher, modéliser, représenter, calculer, raisonner et communiquer : comprendre l’énoncé, choisir une méthode, justifier et vérifier.',
    prerequis: 'Reformuler l’énoncé avec ses propres mots.',
    erreurs: ['Répondre sans relire la question posée.', 'Ne pas vérifier que le résultat est plausible.'],
    appuis: ['Souligner la question et les données utiles.', 'Faire un schéma ou un tableau avant de calculer.'],
  },

  /* ---------- Français ---------- */
  {
    id: 'fr-grammaire',
    subject: 'francais',
    domain: 'Grammaire de la phrase et accords',
    levels: ALL,
    keywords: [
      'grammaire',
      'accord',
      'fonction',
      'nature',
      'phrase',
      'groupe',
      'proposition',
      'complement',
      'sujet',
      'participe',
    ],
    attendu:
      'Identifier nature et fonction des mots, reconnaître la phrase simple et complexe, accorder sujet-verbe, groupe nominal et participe passé.',
    prerequis: 'Trouver le verbe puis son sujet dans une phrase.',
    erreurs: [
      'Accorder le verbe avec le mot le plus proche plutôt qu’avec son sujet.',
      'Confondre participe passé en -é et infinitif en -er.',
    ],
    appuis: [
      'Remplacer par « vendre » ou « prendre » pour distinguer -é et -er.',
      'Poser la question « qui est-ce qui ? » devant le verbe.',
    ],
  },
  {
    id: 'fr-conjugaison',
    subject: 'francais',
    domain: 'Conjugaison et temps verbaux',
    levels: ALL,
    keywords: [
      'conjugu',
      'temps',
      'verbe',
      'imparfait',
      'futur',
      'passe',
      'present',
      'subjonctif',
      'conditionnel',
      'mode',
    ],
    attendu:
      'Conjuguer aux temps simples et composés de l’indicatif, au conditionnel et à l’impératif, choisir le temps adapté au récit.',
    prerequis: 'Reconnaître l’infinitif et le groupe d’un verbe.',
    erreurs: [
      'Terminaisons du passé simple et de l’imparfait mélangées.',
      'Oublier le -s à la 2e personne du singulier.',
    ],
    appuis: ['Tableau des terminaisons à compléter de mémoire.', 'Réécrire un court texte en changeant de temps.'],
  },
  {
    id: 'fr-orthographe',
    subject: 'francais',
    domain: 'Orthographe lexicale et grammaticale',
    levels: ALL,
    keywords: ['orthograph', 'dictee', 'homophone', 'ecrire sans faute', 'mots'],
    attendu: 'Écrire correctement les mots usuels, distinguer les homophones courants, relire et corriger un texte.',
    prerequis: 'Épeler les mots les plus fréquents du programme.',
    erreurs: ['a / à, et / est, son / sont.', 'Oublier les accords en relisant trop vite.'],
    appuis: [
      'Relire en trois passes : verbes, accords, homophones.',
      'Un carnet de mots difficiles revu régulièrement.',
    ],
  },
  {
    id: 'fr-vocabulaire',
    subject: 'francais',
    domain: 'Vocabulaire et sens des mots',
    levels: ALL,
    keywords: [
      'vocabulaire',
      'lexique',
      'sens',
      'sens des mots',
      'famille',
      'prefixe',
      'suffixe',
      'synonyme',
      'figure',
    ],
    attendu:
      'Enrichir son vocabulaire, retrouver le sens d’un mot par sa formation, repérer sens propre et figuré, synonymes et nuances.',
    prerequis: 'Utiliser le contexte pour deviner un mot inconnu.',
    erreurs: ['Prendre un mot au sens propre dans un texte imagé.', 'Employer un synonyme qui change le registre.'],
    appuis: ['Chercher le radical et la famille du mot.', 'Remplacer le mot dans la phrase pour tester le sens.'],
  },
  {
    id: 'fr-lire',
    subject: 'francais',
    domain: 'Lire et comprendre un texte',
    levels: ALL,
    keywords: ['lire', 'comprendre', 'comprehension', 'lecture', 'interpreter', 'texte', 'analyser', 'document'],
    attendu:
      'Comprendre un texte littéraire ou documentaire, relever des indices, faire des inférences, justifier avec le texte.',
    prerequis: 'Lire un paragraphe et dire de qui et de quoi il parle.',
    erreurs: [
      'Répondre de mémoire sans retourner au texte.',
      'Recopier une phrase entière au lieu d’un indice précis.',
    ],
    appuis: [
      'Surligner qui, où, quand dans le premier paragraphe.',
      'Toujours citer un mot ou une ligne comme preuve.',
    ],
  },
  {
    id: 'fr-ecrire',
    subject: 'francais',
    domain: 'Écrire : rédaction et réécriture',
    levels: ALL,
    keywords: ['ecrire', 'redaction', 'ecrit', 'rediger', 'produire', 'argument', 'recit', 'description', 'paragraphe'],
    attendu: 'Rédiger un texte organisé et cohérent (récit, description, argumentation), le réviser et le corriger.',
    prerequis: 'Écrire une phrase complète avec un sujet et un verbe.',
    erreurs: ['Pas de plan : les idées partent dans tous les sens.', 'Phrases très longues sans ponctuation.'],
    appuis: ['Un plan de trois lignes avant d’écrire.', 'Une grille de relecture : sens, phrases, orthographe.'],
  },
  {
    id: 'fr-oral',
    subject: 'francais',
    domain: 'S’exprimer à l’oral',
    levels: ALL,
    keywords: ['oral', 'exposer', 'parler', 'debat', 'expose', 'prise de parole', 'ecouter'],
    attendu: 'Prendre la parole de façon claire et organisée, écouter, reformuler, participer à un échange.',
    prerequis: 'Dire une idée en deux phrases.',
    erreurs: ['Lire ses notes sans regarder son auditoire.', 'Parler trop vite.'],
    appuis: ['S’enregistrer puis se réécouter.', 'Trois mots-clés plutôt que du texte écrit.'],
  },
  {
    id: 'fr-litterature',
    subject: 'francais',
    domain: 'Culture littéraire et artistique',
    levels: ALL,
    keywords: ['litterature', 'poeme', 'poesie', 'roman', 'theatre', 'conte', 'fable', 'oeuvre', 'culture', 'image'],
    attendu:
      'Situer une œuvre, en reconnaître le genre et les procédés, relier des textes et exprimer une réception personnelle.',
    prerequis: 'Raconter l’histoire d’un texte en quelques phrases.',
    erreurs: ['Confondre narrateur et auteur.', 'Relever un procédé sans dire son effet.'],
    appuis: ['« Procédé + exemple + effet » en une phrase.', 'Une fiche de lecture courte par œuvre.'],
  },

  /* ---------- Anglais ---------- */
  {
    id: 'en-comprehension-orale',
    subject: 'anglais',
    domain: 'Comprendre l’oral',
    levels: ALL,
    keywords: ['comprehension de l oral', 'ecouter', 'listening', 'oral', 'audio'],
    attendu: 'Comprendre l’essentiel d’un message ou d’un court dialogue (niveau A1 en 6e, vers A2 en fin de 3e).',
    prerequis: 'Repérer les mots connus dans un flux de paroles.',
    erreurs: [
      'Chercher à tout comprendre au lieu de saisir l’idée générale.',
      'Confondre des sons proches (ship / sheep).',
    ],
    appuis: ['Écouter d’abord pour le thème, puis pour les détails.', 'Réécouter avec la transcription.'],
  },
  {
    id: 'en-comprehension-ecrite',
    subject: 'anglais',
    domain: 'Comprendre un texte écrit',
    levels: ALL,
    keywords: ['comprehension ecrite', 'lire', 'reading', 'texte', 'comprendre'],
    attendu: 'Comprendre un texte court et simple, repérer des informations précises, deviner un mot par le contexte.',
    prerequis: 'Reconnaître les mots-outils les plus fréquents.',
    erreurs: ['Traduire mot à mot.', 'Passer à côté des mots transparents proches du français.'],
    appuis: ['Surligner les mots connus d’abord.', 'Chercher qui, où, quand dans le texte.'],
  },
  {
    id: 'en-parler',
    subject: 'anglais',
    domain: 'S’exprimer et dialoguer à l’oral',
    levels: ALL,
    keywords: ['parler', 'speaking', 's exprimer oralement', 'dialogu', 'presenter', 'interagir', 'prononc'],
    attendu: 'Se présenter, décrire, raconter simplement, échanger avec des phrases courtes et correctes.',
    prerequis: 'Dire quelques phrases simples sur soi.',
    erreurs: ['Prononcer les lettres comme en français.', 'Rester silencieux de peur de se tromper.'],
    appuis: ['Phrases modèles à réutiliser.', 'S’enregistrer et comparer avec un modèle.'],
  },
  {
    id: 'en-ecrire',
    subject: 'anglais',
    domain: 'Écrire en anglais',
    levels: ALL,
    keywords: ['ecrire', 'writing', 'expression ecrite', 'redaction', 'message', 'email', 'paragraphe'],
    attendu: 'Écrire un message ou un court texte cohérent avec un vocabulaire et des structures connus.',
    prerequis: 'Écrire une phrase simple : sujet, verbe, complément.',
    erreurs: ['Calquer l’ordre des mots du français.', 'Oublier le -s de la 3e personne au présent.'],
    appuis: ['Reprendre des structures vues en classe.', 'Se relire en cherchant les verbes.'],
  },
  {
    id: 'en-grammaire',
    subject: 'anglais',
    domain: 'Grammaire et conjugaison',
    levels: ALL,
    keywords: [
      'grammaire',
      'conjugaison',
      'present',
      'preterit',
      'passe',
      'futur',
      'verbe',
      'modal',
      'comparatif',
      'question',
      'structure',
    ],
    attendu: 'Employer présent simple et continu, prétérit, futur, modaux, comparatifs et questions de façon fiable.',
    prerequis: 'Le verbe to be et to have au présent.',
    erreurs: [
      'Oublier l’auxiliaire do dans une question ou une négation.',
      'Verbes irréguliers mal appris au prétérit.',
    ],
    appuis: ['Une phrase type par temps à réutiliser.', 'Revoir les verbes irréguliers par petits paquets.'],
  },
  {
    id: 'en-lexique',
    subject: 'anglais',
    domain: 'Vocabulaire et culture',
    levels: ALL,
    keywords: ['vocabulaire', 'lexique', 'culture', 'civilisation', 'mot', 'faux ami'],
    attendu:
      'Mobiliser un lexique des thèmes du programme et connaître quelques repères culturels des pays anglophones.',
    prerequis: 'Les mots de la classe et de la vie quotidienne.',
    erreurs: ['Faux amis (actually, library).', 'Apprendre une liste sans phrase d’exemple.'],
    appuis: ['Mot + phrase + image mentale.', 'Revoir en espaçant : le soir, 3 jours après, une semaine après.'],
  },
];

const fold = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’-]/g, ' ');

/** Entrée du recueil la plus proche d'un intitulé de compétence, ou la plus générale de la matière. */
export function curriculumFor(subject: SupportSubject, label: string): CurriculumEntry {
  const text = fold(label);
  const mine = CURRICULUM.filter((e) => e.subject === subject);
  let best: CurriculumEntry | null = null;
  let bestScore = 0;
  for (const entry of mine) {
    // Un mot-clé contenu dans un autre mot-clé déjà trouvé ne compte pas deux fois (« calcul » et « calculer »).
    const found: string[] = [];
    let score = 0;
    for (const k of [...entry.keywords].sort((a, b) => b.length - a.length)) {
      const word = fold(k);
      if (!text.includes(word) || found.some((f) => f.includes(word))) continue;
      found.push(word);
      score += Math.max(1, word.length / 4);
    }
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  if (best) return best;
  const general = mine.find(
    (e) =>
      e.id ===
      (subject === 'maths' ? 'maths-problemes' : subject === 'francais' ? 'fr-lire' : 'en-comprehension-ecrite'),
  );
  return general ?? mine[0]!;
}

export const referenceOf = (level: string): string => (level === '6e' ? SOURCES.repères : SOURCES.cycle4);

/**
 * Fiches adaptées à la lecture (dyslexie) : consignes de rédaction et mise en phrases courtes.
 *
 * Rôle : un parent règle l'adaptation sur la fiche de l'enfant (`SupportChild.dys`). Elle change
 * deux choses : la façon dont les fiches sont écrites (règles ci-dessous, transmises à Claude, ou
 * `easyContent` pour la fiche de secours) et leur présentation à l'écran (voir `skills-view.ts`).
 *
 * Confidentialité : Claude ne reçoit jamais le mot « dyslexie », ni aucun diagnostic. Il reçoit
 * seulement des règles de présentation. Le réglage lui-même reste dans l'espace chiffré de la famille.
 *
 * Logique pure, sans entrée-sortie.
 */
import type { SheetContent, SheetExercise } from './skills.ts';
import type { SupportSubject } from './support.ts';

const COMMON_RULES = [
  'Écris des phrases courtes (12 mots au plus), une seule idée par phrase, avec des mots courants. Évite les doubles négations, le passif et les sous-entendus.',
  'Une seule consigne par phrase, qui commence par un verbe d’action. Quand il y a plusieurs étapes, numérote-les (1., 2., 3.).',
  'Aucun bloc dense : une idée par élément de liste, de une à deux lignes. Un exercice se lit en moins de 40 mots.',
  'Pour chaque mot nouveau ou difficile du rappel, ajoute son découpage en syllabes entre parenthèses, par exemple « fraction (frac-tion) ».',
  'Écris les nombres en chiffres, sans abréviation ni sigle non expliqué.',
  'Montre d’abord un exemple, puis demande de l’imiter. Garde la même formulation pour la même demande d’un exercice à l’autre.',
  'Évite les jeux de mots, l’ironie et les consignes à double sens.',
  'Un corrigé montre la méthode en étapes courtes, jamais un résultat seul.',
];

const SUBJECT_RULES: Record<SupportSubject, string> = {
  maths: 'Pour un calcul, écris une opération par ligne, bien alignée, et nomme chaque étape.',
  francais:
    'N’évalue ni l’orthographe ni la calligraphie : une production écrite demandée se limite à une ou deux phrases.',
  anglais:
    'Pour chaque mot anglais nouveau, ajoute sa prononciation simple entre crochets, par exemple « bird [beurd] ». Préfère des mots courts.',
};

/** Règles de rédaction transmises à Claude pour une fiche adaptée à la lecture. */
export const readingRules = (subject: SupportSubject): string[] => [...COMMON_RULES, SUBJECT_RULES[subject]];

const MAX_WORDS = 14;

/** Guillemets français équilibrés : on ne coupe jamais une citation en deux. */
const balanced = (text: string): boolean => (text.match(/«/g)?.length ?? 0) === (text.match(/»/g)?.length ?? 0);

/** Coupe une phrase longue à la virgule ou au point-virgule le plus proche du milieu, jusqu'à 14 mots. */
function splitLong(sentence: string): string[] {
  const words = sentence.trim().split(/\s+/);
  if (words.length <= MAX_WORDS) return [sentence.trim()];
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 3; i < words.length - 3; i++) {
    if (!/[,;]$/.test(words[i] ?? '')) continue;
    if (!balanced(words.slice(0, i + 1).join(' '))) continue;
    const distance = Math.abs(i + 1 - words.length / 2);
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }
  if (best < 0) return [sentence.trim()];
  const first = words
    .slice(0, best + 1)
    .join(' ')
    .replace(/[,;]$/, '.');
  const rest = words.slice(best + 1).join(' ');
  const second = rest.charAt(0).toUpperCase() + rest.slice(1);
  return [...splitLong(first), ...splitLong(second)];
}

/** Les phrases d'un texte, chacune ramenée à 14 mots quand une virgule le permet. */
export function shortSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap(splitLong);
}

const joined = (text: string): string => shortSentences(text).join(' ');

const easyExercise = (x: SheetExercise): SheetExercise => ({
  consigne: joined(x.consigne),
  indice: joined(x.indice),
  corrige: joined(x.corrige),
});

/** Fiche de secours adaptée : phrases courtes, une idée par élément, moins de texte. */
export function easyContent(content: SheetContent): SheetContent {
  return {
    objectif: joined(content.objectif),
    rappel: content.rappel.flatMap(shortSentences).slice(0, 5),
    guide: easyExercise(content.guide),
    autonomes: content.autonomes.map(easyExercise),
    astuces: content.astuces.flatMap(shortSentences).slice(0, 2),
    encouragement: joined(content.encouragement),
  };
}

/**
 * Client ÉcoleDirecte de démonstration (`ORBITE_DEMO=1`).
 *
 * Trois élèves fictifs, des notes réparties sur dix semaines et des devoirs pour
 * les jours qui viennent. Sert à essayer l'interface ou à la vérifier sans
 * aucune donnée réelle. N'importe quel identifiant est accepté, sans question.
 */
import { parisDate } from '../shared/metrics.ts';
import type { Factor, SavedAuth } from './ecoledirecte.ts';
import type { EdClient } from './ed-service.ts';
import type {
  AuthResult,
  AuthState,
  Child,
  Course,
  Dashboard,
  Homework,
  HomeworkPage,
  Note,
  SchoolInfo,
} from '../shared/types.ts';

const SUBJECTS = [
  'MATHEMATIQUES',
  'FRANCAIS',
  'ANGLAIS LV1',
  'HISTOIRE-GEOGRAPHIE',
  'SVT',
  'PHYSIQUE-CHIMIE',
  'EPS',
  'TECHNOLOGIE',
];
const TITLES = ['Contrôle', 'Interrogation écrite', 'Devoir maison', 'Évaluation', 'Exposé', 'Quiz'];
const TASKS = [
  'Exercices 4 et 5 page 82.',
  'Apprendre la leçon sur les fractions.',
  'Lire le chapitre 3 et répondre aux questions.',
  'Réviser le vocabulaire de l’unité 2.',
  'Préparer la fiche de révision pour le contrôle.',
  'Terminer le schéma de la cellule.',
  'Rédiger un paragraphe argumenté (10 lignes).',
];

function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function day(offset: number): string {
  const d = new Date(parisDate(new Date()) + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

function student(id: string, name: string, className: string, level: number, drift: number, seed: number): Child {
  const rand = seeded(seed);
  const notes: Note[] = [];
  for (let i = 0; i < 34; i++) {
    const ago = Math.floor(rand() * 70);
    const subject = SUBJECTS[Math.floor(rand() * SUBJECTS.length)] ?? 'MATHEMATIQUES';
    const outOf = rand() < 0.2 ? 10 : 20;
    const base = level + drift * (1 - ago / 70) + (rand() - 0.5) * 7;
    const value = Math.round(Math.max(2, Math.min(20, base)) * (outOf / 20) * 2) / 2;
    notes.push({
      id: `${id}-${i}`,
      subject,
      subjectId: subject + ':',
      title: TITLES[Math.floor(rand() * TITLES.length)] ?? 'Contrôle',
      date: day(-ago),
      period: ago > 60 ? 'A001' : 'A002',
      raw: String(value),
      value,
      outOf,
      coefficient: rand() < 0.25 ? 2 : 1,
      classAverage: Math.round((11 + rand() * 3) * (outOf / 20) * 10) / 10,
      excluded: false,
      skills:
        rand() < 0.6
          ? [
              { name: 'Raisonner', detail: '', level: (1 + Math.floor(rand() * 4)) as 1 | 2 | 3 | 4 },
              { name: 'Communiquer', detail: '', level: (1 + Math.floor(rand() * 4)) as 1 | 2 | 3 | 4 },
            ]
          : [],
    });
  }
  return {
    id,
    name,
    lastName: 'Démo',
    className,
    school: 'Collège des Tilleuls',
    photo: null,
    notes,
    periods: [
      { id: 'A001', label: 'Trimestre 1', start: day(-70), end: day(-61), average: null, classAverage: null },
      { id: 'A002', label: 'Trimestre 2', start: day(-60), end: day(30), average: null, classAverage: null },
    ],
  };
}

export class DemoEd implements EdClient {
  state: AuthState = 'anonymous';
  trusted: Factor[] = [];
  clear(): void {
    this.state = 'anonymous';
  }
  async login(): Promise<AuthResult> {
    this.state = 'authenticated';
    return { state: 'authenticated' };
  }
  async verify(): Promise<AuthResult> {
    this.state = 'authenticated';
    return { state: 'authenticated' };
  }
  async dashboard(): Promise<Dashboard> {
    return {
      demo: true,
      updatedAt: new Date().toISOString(),
      children: [
        student('1:21', 'Léo', '5e B', 13.5, 1.4, 7),
        student('1:22', 'Nina', '6e A', 15.2, -1.6, 11),
        student('1:23', 'Malo', '6e C', 11.3, 0.4, 23),
      ],
    };
  }
  async homeworkForChild(childId: string): Promise<HomeworkPage> {
    const rand = seeded(childId.length * 97 + Number(childId.slice(-1)));
    const homework: Homework[] = [];
    for (let offset = 0; offset < 12; offset++) {
      const date = day(offset);
      const weekday = new Date(date + 'T12:00:00Z').getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      const count = Math.floor(rand() * 3) + (offset === 1 ? 2 : 0);
      for (let i = 0; i < count; i++)
        homework.push({
          id: `${date}:${childId.replace(':', '')}${offset}${i}`,
          dueDate: date,
          subject: SUBJECTS[Math.floor(rand() * SUBJECTS.length)] ?? 'FRANCAIS',
          text: TASKS[Math.floor(rand() * TASKS.length)] ?? '',
          status: 'pending',
          exam: rand() < 0.15,
          documents: rand() < 0.2 ? ['Fiche-exercices.pdf'] : [],
        });
    }
    return {
      homework,
      homeworkDates: [],
      homeworkPartial: false,
      homeworkNext: null,
      homeworkUntil: day(29),
    };
  }
  async timetableForChild(childId: string, from: string): Promise<Course[]> {
    const weekday = new Date(from + 'T12:00:00Z').getUTCDay();
    if (weekday === 0 || weekday === 6) return [];
    const shift = Number(childId.slice(-1)) % 3;
    const week: Record<number, string[]> = {
      1: ['MATHEMATIQUES', 'FRANCAIS', 'ANGLAIS LV1', 'HISTOIRE-GEOGRAPHIE', 'SVT', 'TECHNOLOGIE'],
      2: [
        'FRANCAIS',
        'MATHEMATIQUES',
        'ED.PHYSIQUE & SPORT.',
        'ED.PHYSIQUE & SPORT.',
        'ANGLAIS LV1',
        'ARTS PLASTIQUES',
      ],
      3: ['MATHEMATIQUES', 'PHYSIQUE-CHIMIE', 'FRANCAIS', 'EDUCATION MUSICALE'],
      4: ['HISTOIRE-GEOGRAPHIE', 'ANGLAIS LV1', 'MATHEMATIQUES', 'FRANCAIS', 'ED.PHYSIQUE & SPORT.', 'SVT'],
      5: ['FRANCAIS', 'SVT', 'MATHEMATIQUES', 'TECHNOLOGIE', 'HISTOIRE-GEOGRAPHIE', 'ANGLAIS LV1'],
    };
    const slots = ['08:00', '09:00', '10:10', '11:10', '13:30', '14:30', '15:40'];
    const subjects = week[((weekday + shift - 1) % 5) + 1] ?? [];
    return subjects.map((subject, i) => {
      const start = slots[i] ?? '16:00';
      const [h = '8', m = '00'] = start.split(':');
      return {
        id: `${from}-${i}`,
        date: from,
        start,
        end: `${String(Number(h)).padStart(2, '0')}:${String(Number(m) + 55 > 59 ? Number(m) - 5 : Number(m) + 55).padStart(2, '0')}`,
        subject,
        code: subject.slice(0, 4),
        room: `Salle ${101 + i * 7}`,
        teacher: ['M. Martin', 'Mme Bernard', 'Mme Petit', 'M. Durand', 'Mme Leroy', 'M. Moreau'][i % 6] ?? '',
        kind: 'cours',
        cancelled: i === 3 && weekday === 4,
        modified: false,
        exempted: false,
      };
    });
  }
  async schoolInfosForChild(): Promise<SchoolInfo[]> {
    return [
      {
        id: 'demo-1',
        text: 'Photo de classe jeudi matin : pense à une tenue soignée.',
        from: day(-2),
        to: day(10),
      },
    ];
  }
  exportSession(): SavedAuth | null {
    return this.state === 'authenticated' ? { version: 1, token: 'demo', cookies: [], accounts: [] } : null;
  }
  restoreSession(): void {
    this.state = 'authenticated';
  }
}

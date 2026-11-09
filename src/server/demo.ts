/**
 * Client ÉcoleDirecte de démonstration (`ORBITE_DEMO=1`).
 *
 * Trois élèves fictifs, des notes réparties sur dix semaines et des devoirs pour
 * les jours qui viennent. Sert à essayer l'interface ou à la vérifier sans
 * aucune donnée réelle. N'importe quel identifiant est accepté, sans question.
 */
import { parisDate } from '../shared/metrics.ts';
import type { EdDocument, EdFile, EdMail, EdMailDetail, Factor, SavedAuth } from './ecoledirecte.ts';
import type { EdClient } from './ed-service.ts';
import type {
  AuthResult,
  AuthState,
  Child,
  Course,
  Dashboard,
  Homework,
  HomeworkPage,
  Lesson,
  Note,
  SchoolInfo,
  SchoolLife,
  SubjectAverage,
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
const LESSONS = [
  'Correction du devoir maison, puis début du chapitre 4 : les proportions.',
  'Lecture analytique de la scène 2. Relevé des procédés comiques.',
  'Révision du prétérit. Exercices oraux par groupes.',
  'Activité documentaire sur la Révolution industrielle, trace écrite dans le cahier.',
  'Expérience : la dissolution du sel. Schéma à compléter.',
];

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

/** Messages fictifs : quatre pour la famille, deux par élève. */
function demoMails(childId: string | null): EdMailDetail[] {
  const at = (offset: number, time: string) => `${day(offset)}T${time}`;
  if (childId === null)
    return [
      {
        id: '501',
        subject: 'Rencontres parents-professeurs de 5e',
        from: 'Mme Durand · Principale adjointe',
        fromRole: 'staff',
        date: at(-1, '17:42'),
        read: false,
        files: [{ id: '9001', name: 'Planning-des-rencontres.pdf' }],
        text: 'Madame, Monsieur,\nLes rencontres parents-professeurs de 5e auront lieu jeudi de 17 h à 20 h.\nLe planning des rendez-vous est joint à ce message. Merci de réserver un créneau sur ÉcoleDirecte.\nCordialement,\nLa direction',
      },
      {
        id: '502',
        subject: 'Sortie au musée des Beaux-Arts, 6e A',
        from: 'M. Martin',
        fromRole: 'teacher',
        date: at(-3, '12:05'),
        read: true,
        files: [{ id: '9002', name: 'Autorisation-de-sortie.pdf' }],
        text: 'Bonjour,\nLa classe de 6e A visitera le musée des Beaux-Arts mardi prochain.\nDépart 8 h 30 devant le collège, retour pour 12 h.\nMerci de rendre l’autorisation signée avant vendredi.\nM. Martin, professeur d’arts plastiques',
      },
      {
        id: '503',
        subject: 'Absence non justifiée',
        from: 'Vie scolaire · CPE',
        fromRole: 'staff',
        date: at(-6, '10:15'),
        read: true,
        files: [],
        text: 'Bonjour,\nUne absence de deux heures n’a pas encore été justifiée. Merci de le faire depuis ÉcoleDirecte.\nLa vie scolaire',
      },
      {
        id: '504',
        subject: 'Menus de la cantine jusqu’aux vacances',
        from: 'Intendance',
        fromRole: 'staff',
        date: at(-9, '08:30'),
        read: true,
        files: [{ id: '9003', name: 'Menus-novembre.pdf' }],
        text: 'Vous trouverez ci-joint les menus jusqu’aux vacances, également affichés à l’entrée du self.',
      },
    ];
  const n = Number(childId.slice(-1)) || 1;
  return [
    {
      id: `6${n}1`,
      subject: 'Devoir maison à rendre vendredi',
      from: 'Mme Bernard',
      fromRole: 'teacher',
      date: at(-2, '18:20'),
      read: false,
      files: [{ id: `91${n}1`, name: 'DM-chapitre-4.pdf' }],
      text: 'Bonjour à tous,\nLe devoir maison du chapitre 4 est à rendre vendredi, sur copie double.\nPensez à soigner la rédaction.\nMme Bernard',
    },
    {
      id: `6${n}2`,
      subject: 'Club robotique : inscriptions ouvertes',
      from: 'M. Moreau',
      fromRole: 'teacher',
      date: at(-5, '13:10'),
      read: true,
      files: [],
      text: 'Le club robotique reprend le jeudi de 12 h 30 à 13 h 30, salle 204.\nInscriptions auprès de M. Moreau avant la fin de la semaine.',
    },
  ];
}

/** Petit PDF valide d'une page, servi pour toutes les pièces jointes de démonstration. */
const DEMO_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 120]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 52>>stream\nBT /F1 18 Tf 30 60 Td (Orbite - piece jointe) Tj ET\nendstream\nendobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

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
      ...(rand() < 0.2 ? { comment: COMMENTS[Math.floor(rand() * COMMENTS.length)] ?? '' } : {}),
      skills:
        rand() < 0.6
          ? [
              { name: 'Raisonner', detail: '', level: (1 + Math.floor(rand() * 4)) as 1 | 2 | 3 | 4, elemId: '101' },
              { name: 'Communiquer', detail: '', level: (1 + Math.floor(rand() * 4)) as 1 | 2 | 3 | 4, elemId: '102' },
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
    skillScale: [
      { level: 1, label: 'Maîtrise insuffisante', color: '#e8456b' },
      { level: 2, label: 'Maîtrise fragile', color: '#e69500' },
      { level: 3, label: 'Maîtrise satisfaisante', color: '#0a9b9a' },
      { level: 4, label: 'Très bonne maîtrise', color: '#1a9f63' },
    ],
    periods: [
      {
        id: 'A001',
        label: 'Trimestre 1',
        start: day(-70),
        end: day(-61),
        average: null,
        classAverage: null,
        councilDate: day(-58),
        councilTime: '17:30',
        mainTeacher: 'Mme Ferrand',
        subjects: officialAverages(notes.filter((n) => n.period === 'A001')),
      },
      {
        id: 'A002',
        label: 'Trimestre 2',
        start: day(-60),
        end: day(30),
        average: null,
        classAverage: null,
        councilDate: day(36),
        councilTime: '17:30',
        mainTeacher: 'Mme Ferrand',
      },
    ],
  };
}

const COMMENTS = [
  'Bon travail, raisonnement clair.',
  'Des erreurs d’inattention, relis-toi.',
  'Leçon à revoir avant le prochain contrôle.',
  'Très bonne participation à l’oral.',
];

/** Moyennes « officielles » de démonstration, calculées comme le ferait le collège. */
function officialAverages(notes: Note[]): SubjectAverage[] {
  const by = new Map<string, Note[]>();
  for (const n of notes) by.set(n.subjectId, [...(by.get(n.subjectId) ?? []), n]);
  return [...by].map(([id, list]) => {
    const pts = list.reduce((a, n) => a + ((n.value ?? 0) / (n.outOf ?? 20)) * 20 * (n.coefficient ?? 1), 0);
    const coef = list.reduce((a, n) => a + (n.coefficient ?? 1), 0);
    const avg = Math.round((pts / coef) * 100) / 100;
    return {
      id,
      label: list[0]?.subject ?? id,
      average: avg,
      classAverage: 12.4,
      min: 6.5,
      max: 18.2,
      coefficient: 1,
      teachers: ['M. Durand'],
    };
  });
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
  async lessonsForChild(childId: string, date: string): Promise<Lesson[]> {
    const weekday = new Date(date + 'T12:00:00Z').getUTCDay();
    if (weekday === 0 || weekday === 6) return [];
    const rand = seeded(Number(date.replace(/-/g, '')) + Number(childId.slice(-1)));
    return SUBJECTS.filter(() => rand() < 0.45).map((subject, i) => ({
      id: `${date}:${i}`,
      date,
      subject,
      teacher: ['M. Durand', 'Mme Ferrand', 'Mme Lopez', 'M. Petit'][i % 4] ?? '',
      text: LESSONS[Math.floor(rand() * LESSONS.length)] ?? '',
      documents: rand() < 0.2 ? ['Diaporama-du-cours.pdf'] : [],
    }));
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
  async mailbox(childId: string | null): Promise<EdMail[]> {
    return demoMails(childId).map(({ text: _text, ...m }) => m);
  }
  async mail(childId: string | null, id: string): Promise<EdMailDetail> {
    const found = demoMails(childId).find((m) => m.id === id);
    if (!found) throw new Error('Message introuvable.');
    return found;
  }
  async mailFile(fileId: string): Promise<EdFile> {
    return { type: 'application/pdf', name: `piece-${fileId}.pdf`, body: DEMO_PDF };
  }
  async documents(): Promise<EdDocument[]> {
    const kids: [string, string][] = [
      ['1:21', 'Léo'],
      ['1:22', 'Nina'],
      ['1:23', 'Malo'],
    ];
    return [
      ...kids.map(([childId, name], i) => ({
        id: String(900 + i),
        name: `Bulletin du 1er trimestre – ${name}`,
        date: day(-55),
        kind: 'bulletin' as const,
        childId,
      })),
      { id: '910', name: 'Certificat de scolarité', date: day(-62), kind: 'admin', childId: '1:21' },
      { id: '911', name: 'Règlement intérieur', date: day(-66), kind: 'admin', childId: null },
    ];
  }
  async documentFile(): Promise<EdFile> {
    return { type: 'application/pdf', name: 'document.pdf', body: DEMO_PDF };
  }
  async schoolLifeForChild(childId: string): Promise<SchoolLife> {
    const n = Number(childId.slice(-1));
    const base = { by: '', comment: '', todo: '', reason: '', justified: null as boolean | null };
    if (n === 1)
      return {
        events: [
          {
            ...base,
            id: 'se-1',
            kind: 'punition',
            type: 'Punition',
            title: 'Retenue',
            date: day(-4),
            when: 'Mercredi de 13 h à 14 h',
            reason: 'Oublis répétés du matériel de sport',
            todo: '1 heure',
            by: 'M. Durand',
          },
          {
            ...base,
            id: 'ar-1',
            kind: 'retard',
            type: 'Retard',
            title: '10 min',
            date: day(-8),
            when: 'de 08:00 à 08:10',
            reason: 'Bus en retard',
            justified: true,
          },
          {
            ...base,
            id: 'ar-2',
            kind: 'absence',
            type: 'Absence',
            title: '2 cours',
            date: day(-15),
            when: 'de 14:30 à 16:30',
            reason: '',
            justified: false,
          },
        ],
      };
    if (n === 2)
      return {
        events: [
          {
            ...base,
            id: 'se-2',
            kind: 'encouragement',
            type: 'Encouragement',
            title: 'Félicitations',
            date: day(-12),
            when: '',
            reason: 'Très bon investissement en classe',
            by: 'Mme Petit',
          },
        ],
      };
    return {
      events: [
        {
          ...base,
          id: 'ar-3',
          kind: 'absence',
          type: 'Absence',
          title: '1 demi-journée',
          date: day(-20),
          when: 'matin',
          reason: 'Rendez-vous médical',
          justified: true,
        },
      ],
    };
  }
  exportSession(): SavedAuth | null {
    return this.state === 'authenticated' ? { version: 1, token: 'demo', cookies: [], accounts: [] } : null;
  }
  restoreSession(): void {
    this.state = 'authenticated';
  }
}

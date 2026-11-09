/**
 * Client de l'API privée ÉcoleDirecte.
 *
 * Rôle : seul module qui dialogue avec `api.ecoledirecte.com`. Il gère la connexion
 * d'un compte parent (ou élève), la double authentification, puis convertit les
 * notes et le cahier de textes au format partagé d'Orbite (`src/shared/types.ts`).
 * Une instance `EcoleDirecte` correspond à une session de navigateur.
 *
 * Fonctionnement :
 * - Connexion : `GET login.awp?gtk=1` fournit le jeton GTK (cookie et en-tête),
 *   puis `POST login.awp` avec les identifiants. Le code 250 signale une
 *   vérification : question à choix multiple (textes en base64 via
 *   `doubleauth.awp`) ou code TOTP. La réponse validée devient un facteur `fa`
 *   et la connexion est rejouée intégralement (`replay`).
 * - Chaque réponse peut renvoyer un nouveau jeton (`X-Token`) et des cookies :
 *   `capture()` les mémorise, et la requête suivante doit utiliser ce nouveau
 *   jeton. Le serveur sérialise donc les appels d'une même session.
 * - Un compte parent peut couvrir plusieurs établissements : `switchContext`
 *   change le compte actif via `renewtoken.awp` avant de lire ses élèves.
 * - Seuls les élèves du secondaire (6e à terminale) sont exposés : le tableau de
 *   bord repose sur des notes chiffrées.
 *
 * Points d'attention :
 * - API non documentée et susceptible d'évoluer : la version envoyée
 *   (`ED_API_VERSION`, 4.96.3 par défaut) et les codes métier (505, 516, 517,
 *   520/521/525…) proviennent de l'observation du site officiel.
 * - Le mot de passe ne reste en mémoire que pendant la vérification (`pending`)
 *   et n'est jamais exporté : `exportSession()` ne garde que jetons, cookies et
 *   identité minimale des comptes.
 * - Les contenus de devoirs sont du HTML encodé en base64 : `homeworkText` le
 *   réduit à du texte brut, jamais injecté tel quel dans le DOM.
 *
 * Liens : `server.ts` (propriétaire des instances), `shared/metrics.ts`
 * (filtre secondaire, date de Paris, photo), tests `auth`, `homework`, `metrics`.
 */
import { isSecondary, parisDate, photoUrl } from '../shared/metrics.ts';
import type {
  AuthResult,
  AuthState,
  Child,
  Dashboard,
  Homework,
  HomeworkPage,
  Course,
  LifeEvent,
  LifeKind,
  Lesson,
  MailFile,
  Note,
  Period,
  SchoolInfo,
  SchoolLife,
  Skill,
  SkillLevel,
  SubjectAverage,
} from '../shared/types.ts';

/** Message tel que lu sur ÉcoleDirecte, avant les droits et repères propres à Orbite. */
export interface EdMail {
  id: string;
  subject: string;
  from: string;
  fromRole: 'teacher' | 'staff' | 'other';
  date: string;
  read: boolean;
  files: MailFile[];
}

export interface EdMailDetail extends EdMail {
  text: string;
}

export interface EdFile {
  type: string;
  name: string;
  body: Buffer;
}

const BASE = 'https://api.ecoledirecte.com/v3/';
// Les en-têtes (User-Agent, Origin, Referer) imitent le site officiel pour être traités comme lui.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

type Id = number | string;

export interface EdBody<T = unknown> {
  code?: number | string;
  token?: string;
  message?: string;
  data?: T;
}

// Les champs `?: T | undefined` peuvent être recopiés tels quels depuis une autre
// structure lors de l'export de session (`exactOptionalPropertyTypes`).
interface RawClasse {
  code?: string | undefined;
  libelle?: string | undefined;
}

interface RawProfile {
  classe?: RawClasse | undefined;
  photo?: string | null;
  eleves?: RawStudent[];
}

export interface RawStudent {
  id: Id;
  prenom?: string | undefined;
  nom?: string | undefined;
  nomEtablissement?: string | undefined;
  photo?: string | null;
  classe?: RawClasse | undefined;
  profile?: RawProfile;
}

export interface RawAccount extends RawStudent {
  idLogin?: Id | undefined;
  main?: boolean | undefined;
  typeCompte?: string | undefined;
}

interface RawDiscipline {
  codeMatiere?: string;
  codeSousMatiere?: string;
  discipline?: string;
  libelleMatiere?: string;
  sousMatiere?: boolean;
  groupeMatiere?: boolean;
  moyenne?: unknown;
  moyenneClasse?: unknown;
  moyenneMin?: unknown;
  moyenneMax?: unknown;
  coef?: unknown;
  professeurs?: { nom?: string }[];
}

interface RawPeriod {
  codePeriode?: string;
  idPeriode?: string;
  periode?: string;
  annuel?: boolean;
  dateDebut?: string;
  dateFin?: string;
  dateConseil?: string;
  heureConseil?: string;
  ensembleMatieres?: {
    nomPP?: string;
    moyenneGenerale?: unknown;
    moyenneClasse?: unknown;
    disciplines?: RawDiscipline[];
  };
}

interface RawNote {
  id?: Id;
  codeMatiere?: string;
  codeSousMatiere?: string;
  libelleMatiere?: string;
  libelleSousMatiere?: string;
  devoir?: string;
  typeDevoir?: string;
  date?: string;
  codePeriode?: string;
  valeur?: unknown;
  noteSur?: unknown;
  coef?: unknown;
  moyenneClasse?: unknown;
  enLettre?: boolean;
  nonSignificatif?: boolean;
  commentaire?: unknown;
  elementsProgramme?: RawSkill[];
}

/** Compétence évaluée avec la note (collège) : `valeur` de 1 (insuffisante) à 4 (très bonne). */
interface RawSkill {
  libelleCompetence?: string;
  descriptif?: string;
  valeur?: unknown;
  idElemProg?: unknown;
  idCompetence?: unknown;
  afc?: unknown;
}

export interface RawNotesData {
  parametrage?: {
    affichageMoyenne?: boolean;
    moyenneGenerale?: boolean;
    moyenneClasse?: boolean;
    affichageNote?: boolean;
    affichageMoyenneDevoir?: boolean;
    coefficientNote?: boolean;
    libelleEval1?: unknown;
    libelleEval2?: unknown;
    libelleEval3?: unknown;
    libelleEval4?: unknown;
    couleurEval1?: unknown;
    couleurEval2?: unknown;
    couleurEval3?: unknown;
    couleurEval4?: unknown;
  };
  notes?: RawNote[];
  periodes?: RawPeriod[];
}

interface RawHomeworkEntry {
  idDevoir?: Id;
  aFaire?: unknown;
  effectue?: unknown;
  matiere?: string;
  interrogation?: boolean;
}

interface RawHomeworkTask {
  idDevoir?: Id;
  effectue?: unknown;
  contenu?: unknown;
  documents?: { libelle?: string }[];
}

interface RawHomeworkSubject {
  id?: Id;
  matiere?: string;
  nomProf?: string;
  interrogation?: boolean;
  aFaire?: RawHomeworkTask;
  contenuDeSeance?: { contenu?: unknown; documents?: { libelle?: string }[] };
}

interface HomeworkEntry extends RawHomeworkEntry {
  dueDate: string;
  key: string;
}

/**
 * Instantané du cahier de textes d'un élève, conservé 60 s pour que la pagination
 * (« Voir plus ») parcoure une liste stable même si ÉcoleDirecte change entre-temps.
 */
interface HomeworkSnapshot {
  /** Index à venir, trié par date ; une ligne par devoir. */
  entries: HomeworkEntry[];
  /** Détail par jour (`YYYY-MM-DD`), chargé à la demande puis réutilisé. */
  details: Map<string, RawHomeworkSubject[]>;
  time: number;
  /** Dernier jour inclus dans le premier affichage (aujourd'hui + 29 jours, heure de Paris). */
  end: string;
  /** Vrai si une partie de l'index était inexploitable. */
  partial: boolean;
}

/** Facteur de double authentification renvoyé par `doubleauth.awp` et rejoué dans `fa`. */
export interface Factor {
  cn: string;
  cv: string;
  uniq?: boolean;
}

interface LoginPayload {
  identifiant: string;
  motdepasse: string;
  isReLogin: boolean;
  uuid: string;
  fa: Factor[];
  cn?: string;
  cv?: string;
}

interface SessionIdentity {
  id: Id;
  prenom?: string | undefined;
  nom?: string | undefined;
  nomEtablissement?: string | undefined;
  photo: string | null;
  classe?: RawClasse | undefined;
}

/** Forme persistée dans le coffre ; `version` permet de refuser un format inconnu. */
export interface SavedAuth {
  version: 1;
  token: string;
  gtk?: string | undefined;
  twoFa?: string | undefined;
  cookies: [string, string][];
  activeId?: Id | undefined;
  accounts: RawAccount[];
}

export interface VerifyInput {
  choice?: unknown;
  code?: unknown;
}

/**
 * Erreur destinée à l'utilisateur : `message` est affiché tel quel dans l'interface,
 * `status` devient le code HTTP renvoyé par le serveur, `code` reprend le code
 * ÉcoleDirecte éventuel. Toute autre erreur est masquée par un message générique.
 */
export class EdError extends Error {
  status: number;
  code: unknown;

  constructor(message: string, status = 502, code?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Éléments objets d'une liste ÉcoleDirecte. Une valeur qui n'est pas un tableau
 * donne une liste vide et les éléments `null` ou primitifs sont ignorés : une
 * réponse dégradée réduit l'affichage au lieu de faire planter le traitement.
 * Les champs des éléments restent à vérifier là où ils sont utilisés.
 */
function records<T extends object>(value: unknown): T[] {
  return Array.isArray(value)
    ? value.filter((item): item is T => typeof item === 'object' && item !== null && !Array.isArray(item))
    : [];
}

const isId = (value: unknown): value is Id => typeof value === 'number' || (typeof value === 'string' && value !== '');

// Message montré à la famille : celui d'une EdError, jamais le détail d'une erreur interne.
const userMessage = (error: unknown): string =>
  error instanceof EdError ? error.message : 'Réponse ÉcoleDirecte inattendue pour cet élève.';

const classLabel = (s: RawStudent): string | undefined =>
  s.classe?.libelle || s.profile?.classe?.libelle || s.classe?.code || s.profile?.classe?.code;

export class EcoleDirecte {
  fetch: typeof fetch;
  cookies = new Map<string, string>();
  version = process.env.ED_API_VERSION || '4.96.3';
  state: AuthState = 'anonymous';
  accounts: RawAccount[] = [];
  factors: Factor[] = [];
  choices: string[] = [];
  challenges = 0;
  gtk: string | undefined;
  token: string | undefined;
  twoFa: string | undefined;
  pending: LoginPayload | undefined;
  /**
   * Facteurs issus d'une question de sécurité validée : ÉcoleDirecte les accepte
   * aux connexions suivantes (comme le « se souvenir de cet appareil » du site),
   * ce qui permet la reconnexion automatique sans nouvelle question. Un code
   * TOTP, à usage unique, n'est jamais conservé ici.
   */
  trusted: Factor[] = [];
  activeId: Id | undefined;
  homeworkSnapshots: Map<string, HomeworkSnapshot> | undefined;

  constructor(transport: typeof fetch = fetch) {
    this.fetch = transport;
  }

  /** Mémorise cookies et jetons tournants (GTK, X-Token, 2FA-Token) de chaque réponse. */
  capture(res: Response): void {
    for (const cookie of res.headers.getSetCookie()) {
      const pair = cookie.split(';')[0] ?? '';
      const i = pair.indexOf('=');
      if (i > 0) this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    this.gtk = res.headers.get('x-gtk') || this.cookies.get('GTK') || this.gtk;
    this.token = res.headers.get('x-token') || this.token;
    this.twoFa = res.headers.get('2fa-token') || this.twoFa;
  }

  private async send(path: string, data: unknown, bootstrap: boolean): Promise<Response> {
    const headers: Record<string, string> = {
      'User-Agent': UA,
      Accept: 'application/json',
      Origin: 'https://www.ecoledirecte.com',
      Referer: 'https://www.ecoledirecte.com/',
    };
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (this.token) headers['X-Token'] = this.token;
    if (this.twoFa) headers['2FA-Token'] = this.twoFa;
    // Le GTK n'est attendu que sur la connexion elle-même, pas sur l'amorçage qui le fournit.
    if (this.gtk && path.startsWith('login') && !bootstrap) headers['X-Gtk'] = this.gtk;
    if (!bootstrap) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    let response: Response;
    try {
      response = await this.fetch(
        BASE + path + (path.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(this.version),
        {
          method: bootstrap ? 'GET' : 'POST',
          headers,
          body: bootstrap ? null : new URLSearchParams({ data: JSON.stringify(data ?? {}) }),
          signal: AbortSignal.timeout(20000),
          // Une redirection signalerait une page de maintenance ou de connexion, pas du JSON.
          redirect: 'error',
        },
      );
    } catch {
      throw new EdError('ÉcoleDirecte est injoignable. Vérifiez votre connexion, puis réessayez.');
    }
    this.capture(response);
    if (!response.ok) throw new EdError(`ÉcoleDirecte est indisponible (HTTP ${response.status}).`);
    return response;
  }

  private async bootstrap(): Promise<void> {
    const response = await this.send('login.awp?gtk=1', undefined, true);
    const text = await response.text();
    try {
      this.gtk = (JSON.parse(text) as { token?: string }).token || this.gtk;
    } catch {}
    if (!this.gtk) throw new EdError('Le jeton initial GTK est absent. Le protocole ÉcoleDirecte a peut-être évolué.');
  }

  async request<T = unknown>(path: string, data?: unknown): Promise<EdBody<T>> {
    const response = await this.send(path, data, false);
    let body: EdBody<T>;
    try {
      body = (await response.json()) as EdBody<T>;
    } catch {
      throw new EdError('Réponse ÉcoleDirecte non reconnue.');
    }
    this.token = response.headers.get('x-token') || body.token || this.token;
    // Codes métier (le statut HTTP vaut 200 même en cas d'erreur) : 200 succès,
    // 250 vérification requise, 520/521/525 jeton expiré ou invalidé.
    if ([520, 521, 525].includes(Number(body.code))) {
      this.clear();
      throw new EdError('Votre session a expiré. Reconnectez-vous.', 401, body.code);
    }
    if (![200, 250].includes(Number(body.code))) {
      const messages: Record<string, string> = {
        505: 'Identifiant, mot de passe ou vérification refusé.',
        517: 'Version API refusée. Ajustez ED_API_VERSION.',
        516: 'Compte temporairement bloqué. Connectez-vous sur le site ÉcoleDirecte.',
        535: 'Établissement ou compte indisponible.',
      };
      throw new EdError(
        messages[String(body.code)] || `ÉcoleDirecte a refusé la demande (code ${body.code ?? 'inconnu'}).`,
        400,
        body.code,
      );
    }
    return body;
  }

  async login(username: string, password: string, factors: Factor[] = []): Promise<AuthResult> {
    this.clear();
    const known = factors.filter((f) => typeof f?.cn === 'string' && f.cn && typeof f.cv === 'string' && f.cv);
    const last = known.at(-1);
    this.pending = { identifiant: username, motdepasse: password, isReLogin: false, uuid: '', fa: known };
    if (last) Object.assign(this.pending, { cn: last.cn, cv: last.cv });
    try {
      return await this.replay();
    } catch (e) {
      this.clear();
      throw e;
    }
  }

  /**
   * Rejoue la connexion avec les facteurs déjà obtenus. Comme le site officiel,
   * chaque tentative repart d'un GTK neuf : le jeton d'amorçage est à usage unique.
   */
  async replay(): Promise<AuthResult> {
    this.gtk = undefined;
    await this.bootstrap();
    return this.accept(
      await this.request<{ accounts?: RawAccount[]; id?: Id; totp?: boolean }>('login.awp', this.pending),
    );
  }

  /**
   * Interprète la réponse de `login.awp` : succès (200) ou nouvelle vérification
   * (250). Au-delà de quatre vérifications consécutives, la connexion est
   * abandonnée pour ne pas boucler ni bloquer le compte.
   */
  async accept(body: EdBody<{ accounts?: RawAccount[]; id?: Id; totp?: boolean }>): Promise<AuthResult> {
    if (Number(body.code) === 200) {
      if (!this.token || !Array.isArray(body.data?.accounts)) throw new EdError('Réponse de connexion incomplète.');
      this.accounts = records<RawAccount>(body.data.accounts).filter((a) => isId(a.id));
      this.activeId = body.data.id ?? this.accounts.find((a) => a.main)?.id ?? this.accounts[0]?.id;
      this.trusted = (this.pending?.fa ?? []).filter((f) => f.cn).map(({ cn, cv }) => ({ cn, cv }));
      this.pending = undefined;
      this.factors = [];
      this.state = 'authenticated';
      return { state: this.state };
    }
    if (!this.pending || ++this.challenges > 4) {
      this.clear();
      throw new EdError('Vérifications répétées. Connectez-vous une fois sur le site ÉcoleDirecte.', 400);
    }
    if (body.data?.totp) {
      this.state = 'totp';
      return { state: 'totp' };
    }
    const question = await this.request<{ question?: string; propositions?: string[] }>(
      'connexion/doubleauth.awp?verbe=get',
      {},
    );
    const { question: text, propositions } = question.data ?? {};
    if (
      Number(question.code) !== 200 ||
      typeof text !== 'string' ||
      !text ||
      !Array.isArray(propositions) ||
      !propositions.length ||
      !propositions.every((p) => typeof p === 'string')
    )
      throw new EdError('Question de sécurité indisponible.');
    this.choices = propositions;
    this.state = 'question';
    return {
      state: 'question',
      question: Buffer.from(text, 'base64').toString('utf8'),
      choices: this.choices.map((v) => Buffer.from(v, 'base64').toString('utf8')),
    };
  }

  async verify({ choice, code }: VerifyInput): Promise<AuthResult> {
    if (!this.pending) throw new EdError('Relancez la connexion.', 400);
    if (this.state === 'totp') {
      if (typeof code !== 'string' || !/^\d{6}$/.test(code))
        throw new EdError('Saisissez le code à six chiffres.', 400);
      this.pending.fa = [{ cn: '', cv: code }];
    } else if (this.state === 'question') {
      if (typeof choice !== 'number' || !Number.isInteger(choice) || !this.choices[choice])
        throw new EdError('Choisissez une réponse.', 400);
      const answer = await this.request<{ cn?: string; cv?: string }>('connexion/doubleauth.awp?verbe=post', {
        choix: this.choices[choice],
      });
      // `choix` est renvoyé encodé, tel que reçu : seul l'affichage est décodé.
      const { cn, cv } = answer.data || {};
      if (Number(answer.code) !== 200 || !cn || !cv) throw new EdError('Réponse de sécurité refusée.', 400);
      // Les facteurs s'accumulent : une seconde question peut suivre la première.
      this.factors.push({ cn, cv, uniq: false });
      Object.assign(this.pending, { cn, cv, fa: this.factors });
    } else throw new EdError('Aucune vérification en cours.', 400);
    return this.replay();
  }

  /**
   * Active le compte `account` côté ÉcoleDirecte avant de lire ses élèves. Le
   * jeton courant n'ouvre que le compte actif ; `renewtoken.awp` en émet un pour
   * l'autre compte (récupéré par `request`).
   */
  private async switchContext(account: RawAccount, missing: string): Promise<void> {
    if (account.id === this.activeId) return;
    if (!account.idLogin) throw new EdError(missing);
    const switched = await this.request('renewtoken.awp?verbe=post', { idUser: account.idLogin, uuid: '' });
    if (Number(switched.code) !== 200) throw new EdError('Changement de contexte refusé.');
    this.activeId = account.id;
  }

  /**
   * Construit le tableau de bord de tous les élèves du secondaire. Les erreurs
   * sont isolées par élève ou par établissement (champ `error`) pour qu'un compte
   * défaillant n'empêche pas l'affichage des autres ; seule une erreur 401
   * (session expirée) interrompt tout.
   */
  async dashboard(): Promise<Dashboard> {
    if (this.state !== 'authenticated') throw new EdError('Connectez-vous à votre compte parent.', 401);
    const children: Child[] = [];
    for (const account of this.accounts) {
      // Compte élève (`E`) : il est lui-même l'élève. Compte famille : ses `eleves`.
      const students = (account.typeCompte === 'E' ? [account] : records<RawStudent>(account.profile?.eleves)).filter(
        (s) => isSecondary(classLabel(s)),
      );
      if (!students.length) continue;
      try {
        await this.switchContext(account, 'Le contexte de cet établissement ne peut pas être sélectionné.');
        for (const student of students) {
          const child: Child = {
            photo: photoUrl(student.photo || student.profile?.photo),
            // Identifiant composite : un même élève peut apparaître sous deux comptes.
            id: `${account.id}:${student.id}`,
            name: student.prenom || 'Élève',
            lastName: student.nom || '',
            className: student.classe?.libelle || student.profile?.classe?.libelle || '',
            school: student.nomEtablissement || account.nomEtablissement || '',
            notes: [],
            periods: [],
          };
          // La photo est facultative : son échec ne doit pas masquer les notes.
          if (!child.photo) {
            try {
              const profile = await this.request<{ photo?: string; profile?: { photo?: string } }>(
                `eleves/${encodeURIComponent(student.id)}.awp?verbe=get`,
                {},
              );
              child.photo = photoUrl(profile.data?.photo || profile.data?.profile?.photo);
            } catch (e) {
              if ((e as EdError).status === 401) throw e;
            }
          }
          try {
            const response = await this.request<RawNotesData>(
              `eleves/${encodeURIComponent(student.id)}/notes.awp?verbe=get`,
              { anneeScolaire: '' },
            );
            if (Number(response.code) !== 200) throw new EdError('Accès aux notes à vérifier sur ÉcoleDirecte.');
            Object.assign(child, normalizeNotes(response.data));
          } catch (e) {
            if ((e as EdError).status === 401) throw e;
            Object.assign(child, { error: userMessage(e), notes: [], periods: [] });
          }
          children.push(child);
        }
      } catch (e) {
        if ((e as EdError).status === 401) throw e;
        // Changement de contexte impossible : chaque élève restant reçoit une carte d'erreur.
        for (const s of students)
          if (!children.some((c) => c.id === `${account.id}:${s.id}`))
            children.push({
              id: `${account.id}:${s.id}`,
              name: s.prenom || 'Élève',
              className: s.classe?.libelle || '',
              error: userMessage(e),
              notes: [],
              periods: [],
            });
      }
    }
    return { demo: false, updatedAt: new Date().toISOString(), children };
  }

  async homeworkForChild(childId: string, options: { cursor?: number | null } = {}): Promise<HomeworkPage> {
    if (this.state !== 'authenticated') throw new EdError('Reconnectez-vous.', 401);
    for (const account of this.accounts) {
      const students = account.typeCompte === 'E' ? [account] : records<RawStudent>(account.profile?.eleves);
      const student = students.find((s) => `${account.id}:${s.id}` === childId && isSecondary(classLabel(s)));
      if (!student) continue;
      await this.switchContext(account, 'Contexte de cet établissement indisponible.');
      return this.homework(student.id, options);
    }
    throw new EdError('Élève introuvable.', 404);
  }

  /** Trouve l'élève et active son établissement, puis exécute `run` avec son identifiant ÉcoleDirecte. */
  private async forChild<T>(childId: string, run: (studentId: Id) => Promise<T>): Promise<T> {
    if (this.state !== 'authenticated') throw new EdError('Reconnectez-vous.', 401);
    for (const account of this.accounts) {
      const students = account.typeCompte === 'E' ? [account] : records<RawStudent>(account.profile?.eleves);
      const student = students.find((s) => `${account.id}:${s.id}` === childId && isSecondary(classLabel(s)));
      if (!student) continue;
      await this.switchContext(account, 'Contexte de cet établissement indisponible.');
      return run(student.id);
    }
    throw new EdError('Élève introuvable.', 404);
  }

  /** Emploi du temps de `from` à `to` inclus (`YYYY-MM-DD`), trié par date et heure. */
  timetableForChild(childId: string, from: string, to: string): Promise<Course[]> {
    return this.forChild(childId, async (studentId) => {
      const body = await this.request<unknown>(`E/${encodeURIComponent(studentId)}/emploidutemps.awp?verbe=get`, {
        dateDebut: from,
        dateFin: to,
        avecTrous: false,
      });
      if (Number(body.code) !== 200) throw new EdError('Emploi du temps indisponible.');
      return normalizeTimetable(body.data);
    });
  }

  /** Contenu des séances d'un jour (« ce qui a été fait en classe »). */
  lessonsForChild(childId: string, date: string): Promise<Lesson[]> {
    return this.forChild(childId, async (studentId) => {
      const body = await this.request<{ matieres?: unknown }>(
        `Eleves/${encodeURIComponent(studentId)}/cahierdetexte/${date}.awp?verbe=get`,
        {},
      );
      if (Number(body.code) !== 200) throw new EdError('Cahier de textes indisponible.');
      return normalizeLessons(date, body.data?.matieres);
    });
  }

  /** Informations de l'établissement (post-its de l'accueil ÉcoleDirecte). */
  schoolInfosForChild(childId: string): Promise<SchoolInfo[]> {
    return this.forChild(childId, async (studentId) => {
      const body = await this.request<{ postits?: unknown }>(
        `E/${encodeURIComponent(studentId)}/timelineAccueilCommun.awp?verbe=get`,
        {},
      );
      if (Number(body.code) !== 200) return [];
      return records<{ id?: Id; contenu?: unknown; dateDebut?: string; dateFin?: string }>(body.data?.postits)
        .map((p, i) => ({
          id: String(p.id ?? i),
          text: homeworkText(p.contenu),
          from: frenchDate(p.dateDebut),
          to: frenchDate(p.dateFin),
        }))
        .filter((p) => p.text);
    });
  }

  /**
   * Compte famille (parent) : la messagerie famille porte son identifiant. Le
   * contexte est activé avant l'appel, comme pour les élèves.
   */
  private async forFamily<T>(run: (familyIds: Id[]) => Promise<T>): Promise<T> {
    if (this.state !== 'authenticated') throw new EdError('Reconnectez-vous.', 401);
    const account = this.accounts.find((a) => a.typeCompte !== 'E');
    if (!account) throw new EdError('Aucun compte famille : la messagerie parent est indisponible.', 404);
    await this.switchContext(account, 'Contexte du compte famille indisponible.');
    const ids = [account.id, account.idLogin].filter((v, i, all): v is Id => isId(v) && all.indexOf(v) === i);
    return run(ids);
  }

  /**
   * Messages reçus de l'année en cours, sans leur contenu : messagerie famille
   * (`childId === null`) ou messagerie de l'élève lue depuis le compte parent.
   * La liste ne modifie rien ; seule l'ouverture d'un message (`mail`) peut le
   * marquer comme lu sur ÉcoleDirecte, comme sur le site.
   */
  mailbox(childId: string | null): Promise<EdMail[]> {
    const query =
      'messages.awp?force=false&typeRecuperation=received&idClasseur=0&orderBy=date&order=desc&query=&onlyRead=&page=0&itemsPerPage=100&getAll=0&verbe=get';
    const data = { anneeMessages: schoolYear() };
    if (childId === null)
      return this.forFamily(async (ids) => {
        let last: unknown;
        // Selon les comptes, la messagerie famille répond à l'identifiant du compte ou à celui de connexion.
        for (const id of ids) {
          try {
            const body = await this.request<unknown>(`familles/${encodeURIComponent(id)}/${query}`, data);
            return mailRecords(body.data).map(normalizeMail);
          } catch (e) {
            if ((e as EdError).status === 401) throw e;
            last = e;
          }
        }
        throw last instanceof EdError ? last : new EdError('Messagerie famille indisponible.');
      });
    return this.forChild(childId, async (studentId) => {
      const body = await this.request<unknown>(`eleves/${encodeURIComponent(studentId)}/${query}`, data);
      return mailRecords(body.data).map(normalizeMail);
    });
  }

  /** Message complet (texte brut) ; `id` vient de `mailbox`. */
  mail(childId: string | null, id: string): Promise<EdMailDetail> {
    if (!/^\d{1,12}$/.test(id)) return Promise.reject(new EdError('Message introuvable.', 404));
    const path = `messages/${id}.awp?verbe=get&mode=destinataire`;
    const data = { anneeMessages: schoolYear() };
    const read = (body: EdBody<unknown>) => {
      const raw = (body.data ?? {}) as RawMail;
      const text =
        typeof raw.content === 'string' && raw.content
          ? homeworkText(raw.content)
          : typeof raw.contentHtml === 'string'
            ? htmlText(raw.contentHtml)
            : '';
      return { ...normalizeMail({ ...raw, id: raw.id ?? id }), text };
    };
    if (childId === null)
      return this.forFamily(async (ids) => {
        let last: unknown;
        for (const fid of ids) {
          try {
            return read(await this.request<unknown>(`familles/${encodeURIComponent(fid)}/${path}`, data));
          } catch (e) {
            if ((e as EdError).status === 401) throw e;
            last = e;
          }
        }
        throw last instanceof EdError ? last : new EdError('Message indisponible.');
      });
    return this.forChild(childId, async (studentId) =>
      read(await this.request<unknown>(`eleves/${encodeURIComponent(studentId)}/${path}`, data)),
    );
  }

  /** Pièce jointe d'un message, limitée à 20 Mo. */
  async mailFile(fileId: string): Promise<EdFile> {
    if (this.state !== 'authenticated') throw new EdError('Reconnectez-vous.', 401);
    if (!/^\d{1,12}$/.test(fileId)) throw new EdError('Pièce jointe introuvable.', 404);
    const response = await this.send(
      `telechargement.awp?verbe=get&fichierId=${fileId}&leTypeDeFichier=PIECE_JOINTE&anneeMessages=${schoolYear()}`,
      { forceDownload: 0 },
      false,
    );
    const type = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0]?.trim() ?? '';
    if (/json|text\/html/i.test(type)) {
      let code: unknown;
      try {
        code = ((await response.json()) as EdBody).code;
      } catch {}
      if ([520, 521, 525].includes(Number(code))) {
        this.clear();
        throw new EdError('Votre session a expiré. Reconnectez-vous.', 401, code);
      }
      throw new EdError('Pièce jointe indisponible sur ÉcoleDirecte.', 404);
    }
    const limit = 20 * 1024 * 1024;
    if (Number(response.headers.get('content-length') || 0) > limit)
      throw new EdError('Pièce jointe trop volumineuse pour Orbite (20 Mo au plus).', 413);
    const chunks: Buffer[] = [];
    let size = 0;
    if (response.body)
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > limit) throw new EdError('Pièce jointe trop volumineuse pour Orbite (20 Mo au plus).', 413);
        chunks.push(Buffer.from(chunk));
      }
    return {
      type: type.toLowerCase(),
      name: dispositionName(response.headers.get('content-disposition')),
      body: Buffer.concat(chunks),
    };
  }

  /** Absences, retards, punitions, sanctions et encouragements d'un élève. */
  schoolLifeForChild(childId: string): Promise<SchoolLife> {
    return this.forChild(childId, async (studentId) => {
      const body = await this.request<RawSchoolLife>(
        `eleves/${encodeURIComponent(studentId)}/viescolaire.awp?verbe=get`,
        {},
      );
      return normalizeSchoolLife(body.data);
    });
  }

  /**
   * Devoirs non faits à partir d'aujourd'hui (heure de Paris), en deux temps :
   * - `cursor === null` : premier affichage, tous les devoirs des 30 prochains
   *   jours, et un index rafraîchi s'il date de plus de 60 s ;
   * - `cursor = n` : « Voir plus », les 5 devoirs suivants à partir de la
   *   position `n`, au-delà des 30 jours, dans le même instantané.
   * `homeworkNext` donne le curseur suivant, ou `null` à la fin de la liste.
   * L'index ne dit pas toujours si un devoir est fait : le détail du jour
   * (`/<date>.awp`) fait foi, d'où un chargement par date affichée.
   */
  async homework(
    studentId: Id,
    { cursor = null, now = new Date() }: { cursor?: number | null; now?: Date } = {},
  ): Promise<HomeworkPage> {
    const path = `Eleves/${encodeURIComponent(studentId)}/cahierdetexte`;
    this.homeworkSnapshots ??= new Map();
    let snapshot = this.homeworkSnapshots.get(String(studentId));
    if (!snapshot || (cursor === null && Date.now() - snapshot.time >= 60000)) {
      const index = await this.request<Record<string, RawHomeworkEntry[]>>(path + '.awp?verbe=get', {});
      if (Number(index.code) !== 200 || !index.data || Array.isArray(index.data) || typeof index.data !== 'object')
        throw new EdError('Cahier de textes indisponible.');
      const today = parisDate(now);
      const end = new Date(today + 'T12:00:00Z');
      end.setUTCDate(end.getUTCDate() + 29);
      const entries: HomeworkEntry[] = [];
      let partial = false;
      for (const [dueDate, rows] of Object.entries(index.data).sort(([a], [b]) => a.localeCompare(b))) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !Array.isArray(rows)) {
          partial = true;
          continue;
        }
        if (dueDate < today) continue;
        // `aFaire: false` désigne un contenu de séance, pas un travail à rendre.
        for (const h of rows)
          if (h && h.aFaire !== false)
            entries.push({ ...h, dueDate, key: dueDate + ':' + String(h.idDevoir ?? entries.length) });
      }
      snapshot = { entries, details: new Map(), time: Date.now(), end: end.toISOString().slice(0, 10), partial };
      this.homeworkSnapshots.set(String(studentId), snapshot);
    }
    const current = snapshot;
    // Le curseur est une position dans cette liste ; elle ne doit donc pas dépendre
    // des détails chargés entre deux pages (seul l'index est utilisé ici).
    const pending = current.entries.filter((h) => homeworkDone(h.effectue) !== true);
    const initialCount = pending.filter((h) => h.dueDate <= current.end).length;
    const offset = cursor === null ? 0 : cursor;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > pending.length)
      throw new EdError('Pagination invalide. Actualisez les devoirs.', 400);
    const selected = pending.slice(offset, cursor === null ? initialCount : offset + 5);
    // Dates résumées dans l'interface : au premier affichage, tous les jours de la
    // fenêtre (y compris ceux dont tout est fait) ; ensuite, ceux de la page.
    const dates = new Set(
      cursor === null
        ? current.entries.filter((h) => h.dueDate <= current.end).map((h) => h.dueDate)
        : selected.map((h) => h.dueDate),
    );
    let partial = current.partial;
    const items: Homework[] = [];
    for (const dueDate of new Set(selected.map((h) => h.dueDate))) {
      if (current.details.has(dueDate)) continue;
      try {
        const day = await this.request<{ matieres?: RawHomeworkSubject[] }>(
          path + '/' + dueDate + '.awp?verbe=get',
          {},
        );
        if (Number(day.code) !== 200 || !Array.isArray(day.data?.matieres)) throw new EdError('Détail indisponible.');
        current.details.set(dueDate, records<RawHomeworkSubject>(day.data.matieres));
      } catch (e) {
        if ((e as EdError).status === 401) throw e;
        partial = true;
      }
    }
    // Le détail du jour l'emporte sur l'index ; `done: null` signifie « inconnu ».
    // Le détail peut identifier le devoir par `aFaire.idDevoir` ou, à défaut, par `id`.
    const status = (h: HomeworkEntry) => {
      const detail = current.details
        .get(h.dueDate)
        ?.find((m) => h.idDevoir != null && String(m.aFaire?.idDevoir ?? m.id) === String(h.idDevoir));
      return { detail, done: homeworkDone(detail?.aFaire?.effectue) ?? homeworkDone(h.effectue) };
    };
    for (const h of selected) {
      const { detail, done } = status(h);
      if (done === true) continue;
      const task = detail?.aFaire;
      if (!task) partial = true;
      items.push({
        id: h.key,
        dueDate: h.dueDate,
        subject: detail?.matiere || h.matiere || 'Matière',
        text: homeworkText(task?.contenu),
        status: done === false ? 'pending' : 'unknown',
        exam: !!(detail?.interrogation ?? h.interrogation),
        documents: records<{ libelle?: string }>(task?.documents).map((d) => String(d.libelle || 'Pièce jointe')),
      });
    }
    const homeworkDates = [...dates].sort().map((date) => {
      const rows = current.entries.filter((h) => h.dueDate === date);
      return {
        date,
        total: rows.length,
        done: rows.filter((h) => status(h).done === true).length,
        unknown: rows.filter((h) => status(h).done === null).length,
      };
    });
    const next = offset + selected.length;
    return {
      homework: items,
      homeworkDates,
      homeworkPartial: partial,
      homeworkNext: next < pending.length ? next : null,
      homeworkUntil: current.end,
    };
  }

  /**
   * Données à persister, ou `null` tant que la connexion n'est pas terminée.
   * Les comptes sont réduits au strict nécessaire (identité, classe, photo
   * filtrée) pour limiter les données personnelles écrites sur disque.
   */
  exportSession(): SavedAuth | null {
    if (this.state !== 'authenticated' || this.pending || !this.token) return null;
    return {
      version: 1,
      token: this.token,
      gtk: this.gtk,
      twoFa: this.twoFa,
      cookies: [...this.cookies],
      activeId: this.activeId,
      accounts: this.accounts.map((account) => ({
        ...sessionIdentity(account),
        idLogin: account.idLogin,
        main: account.main,
        typeCompte: account.typeCompte,
        profile: {
          classe: identityClasse(account.profile || {}),
          photo: photoUrl(account.profile?.photo),
          eleves: records<RawStudent>(account.profile?.eleves).map(sessionIdentity),
        },
      })),
    };
  }

  /** Restaure une session issue du coffre après contrôle de forme ; lève une erreur si elle est invalide. */
  restoreSession(input: unknown): void {
    const saved = input as Partial<SavedAuth> | null | undefined;
    if (
      saved?.version !== 1 ||
      typeof saved.token !== 'string' ||
      !saved.token ||
      !Array.isArray(saved.accounts) ||
      !Array.isArray(saved.cookies) ||
      !saved.cookies.every((p) => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === 'string'))
    )
      throw new Error('Session sauvegardée invalide.');
    this.clear();
    this.token = saved.token;
    this.gtk = saved.gtk;
    this.twoFa = saved.twoFa;
    this.cookies = new Map(saved.cookies);
    this.accounts = saved.accounts;
    this.activeId = saved.activeId;
    this.state = 'authenticated';
  }

  clear(): void {
    this.homeworkSnapshots?.clear();
    this.cookies.clear();
    this.gtk = undefined;
    this.token = undefined;
    this.twoFa = undefined;
    this.pending = undefined;
    this.accounts = [];
    this.factors = [];
    this.trusted = [];
    this.choices = [];
    this.challenges = 0;
    this.state = 'anonymous';
  }
}

/**
 * Convertit une valeur ÉcoleDirecte en nombre. Les notes arrivent souvent en
 * chaîne à virgule (« 12,5 ») ; toute autre forme (« Abs », « Disp », lettres)
 * donne `null`.
 */
export function number(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !/^-?\d+(?:[.,]\d+)?$/.test(value.trim())) return null;
  return Number(value.trim().replace(',', '.'));
}

/**
 * Détermine la matière et la sous-matière d'une note.
 *
 * Le libellé d'une note peut désigner la sous-matière (« Oral », « Écrit ») plutôt
 * que la matière. Le nom de la matière parente est donc recherché dans les
 * disciplines des périodes, d'abord dans la période de la note puis dans toutes ;
 * un libellé n'est retenu que s'il est unique, pour ne pas fusionner deux matières
 * partageant un code. Le code matière sert de dernier recours.
 */
function noteSubject(note: RawNote, periods: RawPeriod[]) {
  const code = String(note.codeMatiere || '');
  const sub = String(note.codeSousMatiere || '');
  const disciplines = (p: RawPeriod) => records<RawDiscipline>(p.ensembleMatieres?.disciplines);
  const local = periods.filter((p) => (p.codePeriode || p.idPeriode) === note.codePeriode).flatMap(disciplines);
  const all = periods.flatMap(disciplines);
  const label = (d: RawDiscipline) => String(d.discipline || d.libelleMatiere || '').trim();
  const matches = (d: RawDiscipline) => String(d.codeMatiere || '') === code;
  const parentMatch = (d: RawDiscipline) => matches(d) && !d.codeSousMatiere && !d.sousMatiere;
  const uniqueLabel = (rows: RawDiscipline[]) => {
    const labels = [...new Set(rows.map(label).filter(Boolean))];
    return labels.length === 1 ? (labels[0] ?? '') : '';
  };
  const parent = uniqueLabel(local.filter(parentMatch)) || uniqueLabel(all.filter(parentMatch));
  const subMatch = (d: RawDiscipline) => matches(d) && !!sub && String(d.codeSousMatiere || '') === sub;
  const raw = String(note.libelleMatiere || '').trim();
  const generic = /^(oral|[ée]crit)$/i.test(raw);
  const hasSub = !!sub || generic;
  const parentSubject = parent || (!generic && !sub ? raw : '') || code || 'Matière non précisée';
  const subSubject = hasSub
    ? String(note.libelleSousMatiere || '').trim() ||
      uniqueLabel(local.filter(subMatch)) ||
      uniqueLabel(all.filter(subMatch)) ||
      (raw !== parentSubject ? raw : '')
    : '';
  return {
    parentSubject,
    subSubject,
    subject: subSubject && subSubject !== parentSubject ? `${parentSubject} · ${subSubject}` : parentSubject,
  };
}

/** Séances d'un jour : seules celles dont le professeur a rempli le contenu ou joint un document. */
export function normalizeLessons(date: string, matieres: unknown): Lesson[] {
  return records<RawHomeworkSubject>(matieres)
    .map((m, i) => ({
      id: `${date}:${String(m.id ?? i)}`,
      date,
      subject: String(m.matiere || 'Matière').trim(),
      teacher: String(m.nomProf || '')
        .replace(/^\s*par\s+/i, '')
        .trim(),
      text: homeworkText(m.contenuDeSeance?.contenu),
      documents: records<{ libelle?: string }>(m.contenuDeSeance?.documents).map((d) =>
        String(d.libelle || 'Pièce jointe'),
      ),
    }))
    .filter((l) => l.text || l.documents.length);
}

/** Texte libre ÉcoleDirecte (parfois en HTML) réduit à une ligne propre. */
function cleanText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  return htmlText(value).replace(/\s+/g, ' ').trim().slice(0, 600);
}

/**
 * Conseil de classe, professeur principal et moyennes officielles par matière.
 * Le rang n'est jamais repris : Orbite ne compare pas les élèves entre eux.
 */
function periodExtras(p: RawPeriod, settings: NonNullable<RawNotesData['parametrage']>): Partial<Period> {
  const extras: Partial<Period> = {};
  const date = String(p.dateConseil || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    extras.councilDate = date;
    const time = String(p.heureConseil || '').trim();
    if (/^\d{1,2}:\d{2}$/.test(time)) extras.councilTime = time.padStart(5, '0');
  }
  const pp = String(p.ensembleMatieres?.nomPP || '').trim();
  if (pp) extras.mainTeacher = pp;
  if (settings.affichageMoyenne === false) return extras;
  const hideClass = settings.moyenneClasse === false;
  const subjects: SubjectAverage[] = records<RawDiscipline>(p.ensembleMatieres?.disciplines)
    .filter((d) => !d.groupeMatiere && (d.codeMatiere || d.discipline))
    .map((d) => ({
      id: `${d.codeMatiere || d.discipline}:${d.codeSousMatiere || ''}`,
      label: String(d.discipline || d.libelleMatiere || d.codeMatiere || '').trim(),
      average: number(d.moyenne),
      classAverage: hideClass ? null : number(d.moyenneClasse),
      min: hideClass ? null : number(d.moyenneMin),
      max: hideClass ? null : number(d.moyenneMax),
      coefficient: number(d.coef),
      teachers: records<{ nom?: string }>(d.professeurs)
        .map((t) => String(t.nom || '').trim())
        .filter(Boolean),
    }));
  if (subjects.length) extras.subjects = subjects;
  return extras;
}

/**
 * Convertit la réponse `notes.awp` au format partagé. Les réglages `parametrage`
 * de l'établissement sont respectés : une moyenne ou une note masquée sur
 * ÉcoleDirecte devient `null` (ou disparaît) dans Orbite.
 */
export function normalizeNotes(data: RawNotesData | null = {}): {
  periods: Period[];
  notes: Note[];
  skillScale?: SkillLevel[];
} {
  const settings = data?.parametrage || {};
  const periodes = records<RawPeriod>(data?.periodes);
  const rawNotes = records<RawNote>(data?.notes);
  // Établissement qui masque les coefficients : toutes les notes arrivent avec
  // `coef: 0`. On les compte alors avec un coefficient 1 au lieu de les exclure.
  const hiddenCoefficients =
    settings.coefficientNote === false || (rawNotes.length > 0 && rawNotes.every((n) => !(number(n.coef) ?? 0)));
  const scale = skillScale(settings);
  return {
    ...(scale.length ? { skillScale: scale } : {}),
    periods: periodes.map((p) => ({
      id: p.codePeriode || p.idPeriode,
      label: p.periode,
      annual: p.annuel,
      start: p.dateDebut,
      end: p.dateFin,
      average:
        settings.affichageMoyenne === false || settings.moyenneGenerale === false
          ? null
          : number(p.ensembleMatieres?.moyenneGenerale),
      classAverage: settings.moyenneClasse === false ? null : number(p.ensembleMatieres?.moyenneClasse),
      ...periodExtras(p, settings),
    })),
    notes:
      settings.affichageNote === false
        ? []
        : rawNotes.map((n) => ({
            id: n.id,
            ...noteSubject(n, periodes),
            subjectId: `${n.codeMatiere || n.libelleMatiere}:${n.codeSousMatiere || ''}`,
            title: n.devoir || n.typeDevoir || 'Évaluation',
            date: n.date,
            period: n.codePeriode,
            value: n.enLettre ? null : number(n.valeur),
            raw: String(n.valeur ?? ''),
            outOf: number(n.noteSur),
            coefficient: hiddenCoefficients ? 1 : (number(n.coef) ?? 1),
            classAverage:
              settings.affichageMoyenneDevoir === false || settings.moyenneClasse === false
                ? null
                : number(n.moyenneClasse),
            // Notes non significatives ou en lettres : affichées mais hors moyenne.
            excluded: !!n.nonSignificatif || !!n.enLettre,
            ...(cleanText(n.commentaire) ? { comment: cleanText(n.commentaire) } : {}),
            skills: skills(n.elementsProgramme),
          })),
  };
}

/** « JJ/MM/AAAA » vers « AAAA-MM-JJ » ; `null` si la date est absente ou mal formée. */
export function frenchDate(value: unknown): string | null {
  const m = typeof value === 'string' ? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim()) : null;
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

interface RawCourse {
  id?: Id;
  text?: string;
  matiere?: string;
  codeMatiere?: string;
  typeCours?: string;
  start_date?: string;
  end_date?: string;
  prof?: string;
  salle?: string;
  dispense?: unknown;
  isModifie?: boolean;
  isAnnule?: boolean;
}

/**
 * Convertit l'emploi du temps ÉcoleDirecte (« AAAA-MM-JJ HH:MM ») en cours triés.
 * Les entrées sans date exploitable sont ignorées.
 */
export function normalizeTimetable(data: unknown): Course[] {
  const at = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/;
  return records<RawCourse>(data)
    .flatMap((c, i) => {
      const s = at.exec(String(c.start_date ?? ''));
      const e = at.exec(String(c.end_date ?? ''));
      if (!s?.[1] || !s[2]) return [];
      return [
        {
          id: String(c.id ?? `${s[1]}-${s[2]}-${i}`),
          date: s[1],
          start: s[2],
          end: e?.[2] ?? s[2],
          subject: String(c.matiere || c.text || 'Cours').trim(),
          code: String(c.codeMatiere || '').trim(),
          room: String(c.salle || '').trim(),
          teacher: String(c.prof || '').trim(),
          kind: String(c.typeCours || 'COURS')
            .trim()
            .toLowerCase(),
          cancelled: c.isAnnule === true,
          modified: c.isModifie === true,
          exempted: Number(c.dispense) > 0,
        },
      ];
    })
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}

/**
 * Compétences d'une évaluation. Le niveau n'est retenu que s'il vaut 1 à 4 ;
 * une compétence non positionnée garde `level: null` (jamais un échec) et sa
 * valeur brute. Les identifiants d'ÉcoleDirecte sont conservés : ils permettent
 * de reconnaître la même compétence d'une évaluation à l'autre.
 */
export function skills(value: unknown): Skill[] {
  const id = (v: unknown) =>
    (typeof v === 'number' && v > 0) || (typeof v === 'string' && /^\d{1,12}$/.test(v) && v !== '0');
  return records<RawSkill>(value)
    .map((s) => {
      const level = number(s.valeur);
      const valid = level !== null && Number.isInteger(level) && level >= 1 && level <= 4;
      const raw = String(s.valeur ?? '')
        .trim()
        .slice(0, 20);
      const skill: Skill = {
        name: String(s.libelleCompetence || '').trim(),
        detail: String(s.descriptif || '').trim(),
        level: valid ? (level as Skill['level']) : null,
      };
      if (id(s.idElemProg)) skill.elemId = String(s.idElemProg);
      if (id(s.idCompetence)) skill.competenceId = String(s.idCompetence);
      if (s.afc === 1 || s.afc === true || s.afc === '1') skill.afc = true;
      if (!valid && raw) skill.raw = raw;
      return skill;
    })
    .filter((s) => s.name || s.detail);
}

/**
 * Échelle de l'établissement : libellés en base64 (« Maîtrise fragile »…) et
 * couleurs, qui varient d'un collège à l'autre. On se fie au rang, jamais à la couleur.
 */
export function skillScale(settings: NonNullable<RawNotesData['parametrage']>): SkillLevel[] {
  const levels: SkillLevel[] = [];
  for (const level of [1, 2, 3, 4] as const) {
    const encoded = settings[`libelleEval${level}`];
    let label = '';
    if (typeof encoded === 'string' && encoded)
      try {
        label = Buffer.from(encoded, 'base64')
          .toString('utf8')
          .replace(/[\p{Cc}]/gu, '')
          .trim()
          .slice(0, 60);
      } catch {}
    const color = settings[`couleurEval${level}`];
    if (label)
      levels.push({ level, label, color: typeof color === 'string' && /^#[0-9a-f]{3,8}$/i.test(color) ? color : null });
  }
  return levels.length === 4 ? levels : [];
}

/** État « effectué » d'un devoir, quel que soit son encodage (booléen, 0/1, chaîne) ; `null` si inconnu. */
export function homeworkDone(value: unknown): boolean | null {
  if (value === true || value === 1 || value === 'true' || value === '1') return true;
  if (value === false || value === 0 || value === 'false' || value === '0') return false;
  return null;
}

/**
 * Transforme le contenu d'un devoir (HTML encodé en base64) en texte brut.
 * Scripts et styles sont retirés avec leur contenu, les fins de bloc deviennent
 * des retours à la ligne, les autres balises disparaissent et les entités
 * courantes ou numériques sont décodées. Le client affiche le résultat via
 * `textContent`, jamais `innerHTML`.
 */
export function homeworkText(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  return htmlText(Buffer.from(value, 'base64').toString('utf8'));
}

/**
 * HTML vers texte brut (contenus de devoirs et de messages). Les liens gardent
 * leur adresse entre parenthèses, les puces deviennent « • », les paragraphes
 * restent séparés par une ligne.
 */
export function htmlText(html: string): string {
  const entities: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    eacute: 'é',
    egrave: 'è',
    agrave: 'à',
    ecirc: 'ê',
    ccedil: 'ç',
    ocirc: 'ô',
    ugrave: 'ù',
    rsquo: '’',
    lsquo: '‘',
    ndash: '–',
    mdash: '—',
  };
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_all, url: string, label: string) => {
      const text = label.replace(/<[^>]*>/g, '').trim();
      if (!/^https?:\/\//i.test(url)) return text;
      return !text || text === url ? ` ${url} ` : `${text} (${url})`;
    })
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<br\s*\/?\s*>|<\/(?:p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, key: string) => {
      if (key[0] !== '#') return entities[key] ?? all;
      const n = key[1]?.toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim();
}

function identityClasse(s: {
  classe?: RawClasse | undefined;
  profile?: RawProfile | undefined;
}): RawClasse | undefined {
  const classe = s.classe || s.profile?.classe;
  return classe ? { code: classe.code, libelle: classe.libelle } : undefined;
}

// Identité minimale persistée : les champs nécessaires au tableau de bord et rien d'autre.
function sessionIdentity(s: RawStudent): SessionIdentity {
  return {
    id: s.id,
    prenom: s.prenom,
    nom: s.nom,
    nomEtablissement: s.nomEtablissement,
    photo: photoUrl(s.photo || s.profile?.photo),
    classe: identityClasse(s),
  };
}

/* ---------- Messagerie ---------- */

/** Année scolaire « AAAA-AAAA » de la date donnée (heure de Paris), qui bascule au 1er août. */
export function schoolYear(now = new Date()): string {
  const [y = 2000, m = 9] = parisDate(now).split('-').map(Number);
  const start = m >= 8 ? y : y - 1;
  return `${start}-${start + 1}`;
}

/** Nom de fichier annoncé par `Content-Disposition`, débarrassé de tout chemin. */
export function dispositionName(header: string | null): string {
  if (!header) return 'piece-jointe';
  let name = '';
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header)?.[1];
  if (star) {
    try {
      name = decodeURIComponent(star.trim());
    } catch {}
  }
  if (!name) name = /filename\s*=\s*"?([^";]+)"?/i.exec(header)?.[1]?.trim() ?? '';
  name =
    name
      .split(/[\\/]/)
      .pop()
      ?.replace(/[\p{Cc}"]/gu, '') ?? '';
  return name.slice(0, 120) || 'piece-jointe';
}

interface RawMail {
  id?: Id;
  subject?: string;
  date?: string;
  read?: unknown;
  content?: unknown;
  contentHtml?: unknown;
  from?: {
    name?: string;
    nom?: string;
    prenom?: string;
    particule?: string;
    civilite?: string;
    role?: string;
    fonctionPersonnel?: string;
  };
  files?: { id?: Id; libelle?: string; name?: string }[];
  attachments?: { id?: Id; libelle?: string; name?: string }[];
}

/** Messages reçus, quel que soit le format de réponse (`messages.received` ou `messages`). */
function mailRecords(data: unknown): RawMail[] {
  const messages = (data as { messages?: unknown } | null)?.messages;
  if (Array.isArray(messages)) return records<RawMail>(messages);
  return records<RawMail>((messages as { received?: unknown } | null)?.received);
}

export function normalizeMail(raw: RawMail): EdMail {
  const f = raw.from ?? {};
  const person = [f.civilite, f.prenom, f.particule, f.nom]
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)
    .join(' ');
  const name = String(f.name ?? '').trim() || person || 'Établissement';
  const job = String(f.fonctionPersonnel ?? '').trim();
  const role = String(f.role ?? '').toLowerCase();
  const date = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(String(raw.date ?? ''));
  const files = [
    ...records<NonNullable<RawMail['files']>[number]>(raw.files),
    ...records<NonNullable<RawMail['attachments']>[number]>(raw.attachments),
  ]
    .filter((x) => isId(x.id) && /^\d{1,12}$/.test(String(x.id)))
    .map((x) => ({ id: String(x.id), name: String(x.libelle || x.name || 'Pièce jointe').trim() }));
  return {
    id: String(raw.id ?? ''),
    subject: String(raw.subject ?? '').trim() || '(Sans objet)',
    from: job && !name.includes(job) ? `${name} · ${job}` : name,
    fromRole: role === 'p' || role === 'teacher' ? 'teacher' : role === 'a' || role === 'admin' ? 'staff' : 'other',
    date: date?.[1] && date[2] ? `${date[1]}T${date[2]}` : '',
    read: raw.read === true || raw.read === 1 || raw.read === '1',
    files: files.filter((x, i) => files.findIndex((y) => y.id === x.id) === i),
  };
}

/* ---------- Vie scolaire ---------- */

interface RawLifeEntry {
  id?: Id;
  typeElement?: string;
  date?: string;
  displayDate?: string;
  libelle?: string;
  motif?: string;
  justifie?: unknown;
  typeJustification?: string;
  par?: string;
  commentaire?: string;
  aFaire?: string;
  dateDeroulement?: string;
}

interface RawSchoolLife {
  absencesRetards?: RawLifeEntry[];
  sanctionsEncouragements?: RawLifeEntry[];
  parametrage?: {
    absenceCommentaire?: boolean;
    retardCommentaire?: boolean;
    sanctionsVisible?: boolean;
    sanctionParQui?: boolean;
    sanctionCommentaire?: boolean;
    encouragementsVisible?: boolean;
    encouragementParQui?: boolean;
    encouragementCommentaire?: boolean;
  };
}

function lifeKind(type: string): LifeKind {
  const t = type.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (t.includes('retard')) return 'retard';
  if (t.includes('absence') || t.includes('abscence')) return 'absence';
  if (t.includes('encourag') || t.includes('felicit')) return 'encouragement';
  if (t.includes('punition')) return 'punition';
  if (t.includes('sanction') || t.includes('exclusion') || t.includes('avertissement')) return 'sanction';
  return 'autre';
}

/** Texte court venu d'ÉcoleDirecte : balises retirées, majuscules intégrales adoucies (« RETENUE » → « Retenue »). */
function lifeText(value: unknown, soften = false): string {
  const text = htmlText(String(value ?? ''))
    .replace(/\s*\n\s*/g, ' ')
    .trim();
  if (soften && text.length > 3 && text === text.toUpperCase() && /[A-ZÀ-Ý]/.test(text))
    return text.charAt(0) + text.slice(1).toLowerCase();
  return text;
}

/**
 * Convertit `viescolaire.awp`. Les réglages de l'établissement sont respectés :
 * sanctions ou encouragements masqués sur ÉcoleDirecte restent masqués, de même
 * que l'auteur et les commentaires.
 */
export function normalizeSchoolLife(data: RawSchoolLife | null | undefined): SchoolLife {
  const p = data?.parametrage ?? {};
  const events: LifeEvent[] = [];
  for (const [i, e] of records<RawLifeEntry>(data?.absencesRetards).entries()) {
    const kind = lifeKind(String(e.typeElement ?? 'Absence'));
    const pending = /attente/i.test(String(e.typeJustification ?? ''));
    const showComment = kind === 'retard' ? p.retardCommentaire !== false : p.absenceCommentaire !== false;
    events.push({
      id: `ar-${String(e.id ?? i)}`,
      kind: kind === 'retard' ? 'retard' : 'absence',
      type: lifeText(e.typeElement) || 'Absence',
      title: lifeText(e.libelle),
      date: /^\d{4}-\d{2}-\d{2}/.exec(String(e.date ?? ''))?.[0] ?? null,
      when: lifeText(e.displayDate),
      reason: lifeText(e.motif),
      justified: pending ? null : homeworkDone(e.justifie) === true,
      todo: '',
      by: '',
      comment: showComment ? lifeText(e.commentaire) : '',
    });
  }
  for (const [i, e] of records<RawLifeEntry>(data?.sanctionsEncouragements).entries()) {
    const kind = lifeKind(String(e.typeElement ?? ''));
    const reward = kind === 'encouragement';
    if (reward ? p.encouragementsVisible === false : p.sanctionsVisible === false) continue;
    events.push({
      id: `se-${String(e.id ?? i)}`,
      kind,
      type: lifeText(e.typeElement) || (reward ? 'Encouragement' : 'Sanction'),
      title: lifeText(e.libelle, true),
      date: /^\d{4}-\d{2}-\d{2}/.exec(String(e.date ?? ''))?.[0] ?? null,
      when: lifeText(e.dateDeroulement || e.displayDate),
      reason: lifeText(e.motif),
      justified: null,
      todo: lifeText(e.aFaire),
      by: (reward ? p.encouragementParQui : p.sanctionParQui) === false ? '' : lifeText(e.par),
      comment: (reward ? p.encouragementCommentaire : p.sanctionCommentaire) === false ? '' : lifeText(e.commentaire),
    });
  }
  events.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  return { events };
}

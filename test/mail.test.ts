/**
 * Tests de la messagerie et de la vie scolaire côté ÉcoleDirecte : formats de
 * réponse, texte des messages, réglages de l'établissement respectés.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EcoleDirecte,
  dispositionName,
  htmlText,
  normalizeDocuments,
  normalizeLessons,
  normalizeMail,
  normalizeSchoolLife,
  schoolYear,
} from '../src/server/ecoledirecte.ts';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

test('année scolaire des messages : bascule au 1er août, heure de Paris', () => {
  assert.equal(schoolYear(new Date('2026-11-09T12:00:00Z')), '2026-2027');
  assert.equal(schoolYear(new Date('2027-03-01T12:00:00Z')), '2026-2027');
  assert.equal(schoolYear(new Date('2027-07-31T21:00:00Z')), '2026-2027');
  assert.equal(schoolYear(new Date('2027-07-31T22:30:00Z')), '2027-2028');
});

test('message ÉcoleDirecte normalisé : expéditeur, rôle, date, pièces jointes', () => {
  const m = normalizeMail({
    id: 12345,
    subject: '  Sortie au musée ',
    date: '2026-11-04 18:59:05',
    read: false,
    from: { civilite: 'Mme', prenom: 'K.', nom: 'DUPONT', role: 'A', fonctionPersonnel: 'CPE' },
    files: [
      { id: 8703, libelle: 'autorisation.pdf' },
      { id: 8703, libelle: 'doublon.pdf' },
      { id: 'x', libelle: 'invalide' },
    ],
  });
  assert.deepEqual(m, {
    id: '12345',
    subject: 'Sortie au musée',
    from: 'Mme K. DUPONT · CPE',
    fromRole: 'staff',
    date: '2026-11-04T18:59',
    read: false,
    files: [{ id: '8703', name: 'autorisation.pdf' }],
  });
  assert.equal(normalizeMail({ from: { name: 'M. Martin', role: 'P' } }).fromRole, 'teacher');
  assert.equal(normalizeMail({}).subject, '(Sans objet)');
});

test('texte d’un message : paragraphes, puces, liens http seulement, sans script', () => {
  const text = htmlText(
    '<p>Bonjour,</p><ul><li>point 1</li><li>point 2</li></ul><p>Voir <a href="https://ent.example/doc?a=1&amp;b=2">le document</a> ' +
      'ou <a href="javascript:alert(1)">ceci</a>.</p><script>x()</script>',
  );
  assert.equal(text, 'Bonjour,\n• point 1\n• point 2\nVoir le document (https://ent.example/doc?a=1&b=2) ou ceci.');
});

test('nom de pièce jointe : encodage UTF-8, sans chemin ni guillemets', () => {
  assert.equal(dispositionName("attachment; filename*=UTF-8''r%C3%A9union.pdf"), 'réunion.pdf');
  assert.equal(dispositionName('attachment; filename="../../etc/passwd"'), 'passwd');
  assert.equal(dispositionName(null), 'piece-jointe');
});

test('liste et détail : boîte famille au format `messages.received`, contenu en base64', async () => {
  const calls: string[] = [];
  const ed = new EcoleDirecte(async (url) => {
    calls.push(String(url));
    const path = String(url);
    const data = path.includes('/messages/')
      ? { id: 501, subject: 'Réunion', content: b64('<p>Bonjour</p><p>À jeudi</p>'), files: [] }
      : { messages: { received: [{ id: 501, subject: 'Réunion', date: '2026-11-08 10:00:00', read: true }] } };
    return new Response(JSON.stringify({ code: 200, token: 't2', data }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  ed.restoreSession({
    version: 1,
    token: 't',
    cookies: [],
    accounts: [{ id: 42, typeCompte: '1', main: true, profile: { eleves: [] } }],
    activeId: 42,
  });
  const list = await ed.mailbox(null);
  assert.equal(list[0]?.id, '501');
  assert.match(calls[0] ?? '', /familles\/42\/messages\.awp\?.*typeRecuperation=received/);
  const detail = await ed.mail(null, '501');
  assert.equal(detail.text, 'Bonjour\nÀ jeudi');
  await assert.rejects(ed.mail(null, '../1'), /introuvable/);
});

test('vie scolaire : types, justification, réglages de l’établissement respectés', () => {
  const life = normalizeSchoolLife({
    absencesRetards: [
      {
        id: 1,
        typeElement: 'Absence',
        date: '2026-10-02',
        displayDate: 'le jeudi 02 octobre 2026 de 08:00 à 12:00',
        libelle: '1 demi-journée',
        motif: 'Malade',
        justifie: true,
        typeJustification: ' en attente de prise en compte par la vie scolaire',
        commentaire: 'Mot des parents',
      },
      { id: 2, typeElement: 'Retard', date: '2026-10-13', libelle: '00:10', justifie: false },
    ],
    sanctionsEncouragements: [
      {
        id: 48,
        typeElement: 'Punition',
        date: '2026-11-26',
        libelle: 'RETENUE',
        motif: 'Trop de mots dans le carnet',
        par: 'M. X',
        aFaire: '1 heure',
        dateDeroulement: 'S’est déroulé le mer. 08 décembre<BR>de 13:00 à 14:00',
      },
      { id: 49, typeElement: 'Encouragement', date: '2026-11-20', libelle: 'Félicitations' },
    ],
    parametrage: { sanctionParQui: false, encouragementsVisible: false, absenceCommentaire: false },
  });
  assert.deepEqual(
    life.events.map((e) => [e.kind, e.title, e.justified]),
    [
      ['punition', 'Retenue', null],
      ['retard', '00:10', false],
      ['absence', '1 demi-journée', null],
    ],
  );
  const punition = life.events[0];
  assert.equal(punition?.by, '', 'auteur masqué par l’établissement');
  assert.equal(punition?.todo, '1 heure');
  assert.equal(punition?.when, 'S’est déroulé le mer. 08 décembre de 13:00 à 14:00');
  assert.equal(life.events[2]?.comment, '', 'commentaire d’absence masqué');
  assert.deepEqual(normalizeSchoolLife(null), { events: [] });
});

test('documents : rubriques aplaties, élève rattaché, identifiants invalides écartés', () => {
  const students = new Map([['11', '1:11']]);
  const docs = normalizeDocuments(
    {
      notes: [{ id: 5, libelle: 'Bulletin T1', date: '2026-01-20', idEleve: 11, type: 'Note' }],
      administratifs: [
        { id: '6', libelle: 'Certificat', date: '2025-09-02 10:00', idEleve: 99 },
        { id: '../x', libelle: 'Piège' },
        null,
      ],
      factures: [{ id: 7, libelle: '', date: 'n/a', type: '../../x' }],
      inconnu: [{ id: 8 }],
    },
    students,
  );
  assert.deepEqual(
    docs.map((d) => [d.id, d.kind, d.childId, d.date, d.fileType]),
    [
      ['5', 'bulletin', '1:11', '2026-01-20', 'Note'],
      ['6', 'admin', null, '2025-09-02', ''],
      ['7', 'facture', null, '', 'Facture'],
    ],
  );
  assert.equal(docs[2]?.name, 'Document');
  assert.deepEqual(normalizeDocuments(null, students), []);
});

test('contenu de séance : texte décodé, documents, séances vides écartées', () => {
  const lessons = normalizeLessons('2026-11-05', [
    {
      id: 1,
      matiere: 'MATHÉMATIQUES',
      nomProf: ' par M. DURAND',
      contenuDeSeance: { contenu: b64('<p>Chapitre <b>4</b></p>') },
    },
    { id: 2, matiere: 'SVT', contenuDeSeance: { contenu: '', documents: [{ libelle: 'TP.pdf' }] } },
    { id: 3, matiere: 'EPS', aFaire: { contenu: b64('Courir') } },
    'x',
  ]);
  assert.deepEqual(
    lessons.map((l) => [l.id, l.subject, l.teacher, l.text, l.documents]),
    [
      ['2026-11-05:1', 'MATHÉMATIQUES', 'M. DURAND', 'Chapitre 4', []],
      ['2026-11-05:2', 'SVT', '', '', ['TP.pdf']],
    ],
  );
});

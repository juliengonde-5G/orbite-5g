/**
 * Tests de robustesse face aux réponses ÉcoleDirecte mal formées.
 *
 * Rôle : l'API ÉcoleDirecte n'est pas documentée et peut renvoyer des listes
 * absentes, des objets à la place de tableaux ou des éléments `null`. Ces tests
 * vérifient que de telles réponses dégradent l'affichage (élément ignoré,
 * message générique) au lieu de faire planter le serveur, et qu'aucun message
 * d'erreur interne (`TypeError`…) n'est montré à la famille.
 *
 * Fonctionnement : `EcoleDirecte.request` est remplacé par une fonction qui
 * renvoie des corps volontairement incohérents ; `normalizeNotes` est appelée
 * directement avec des données brutes invalides.
 *
 * Points d'attention : chaque cas reproduit une forme plausible de réponse
 * dégradée. Une garde retirée dans `src/server/ecoledirecte.ts` doit faire
 * échouer au moins un de ces tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EcoleDirecte, normalizeNotes, type RawNotesData } from '../src/server/ecoledirecte.ts';

const setup = (request: (path: string) => Promise<unknown>) => {
  const c = new EcoleDirecte();
  c.state = 'authenticated';
  c.request = request as EcoleDirecte['request'];
  return c;
};

test('notes : listes absentes ou invalides et éléments nuls ignorés', () => {
  const raw = {
    periodes: { T1: {} },
    notes: [null, 'x', { valeur: '12', noteSur: '20', coef: '1', codeMatiere: 'MATH' }],
  } as unknown as RawNotesData;
  const result = normalizeNotes(raw);
  assert.deepEqual(result.periods, []);
  assert.equal(result.notes.length, 1);
  assert.equal(result.notes[0]?.value, 12);
  const withNullPeriod = normalizeNotes({ periodes: [null], notes: [] } as unknown as RawNotesData);
  assert.deepEqual(withNullPeriod.periods, []);
});

test('connexion : comptes invalides écartés, propositions non textuelles refusées', async () => {
  const c = setup(async () => ({ code: 200, data: { question: 'UQ==', propositions: [42] } }));
  c.token = 'jeton';
  const ok = await c.accept({ code: 200, data: { accounts: [null, 'x', { id: 7, typeCompte: 'E' }] } } as never);
  assert.equal(ok.state, 'authenticated');
  assert.deepEqual(
    c.accounts.map((a) => a.id),
    [7],
  );
  c.pending = { identifiant: 'a', motdepasse: 'b', isReLogin: false, uuid: '', fa: [] };
  await assert.rejects(() => c.accept({ code: 250, data: {} }), /Question de sécurité indisponible/);
});

test('tableau de bord : élèves mal formés ignorés, erreur interne jamais affichée', async () => {
  const c = setup(async () => {
    throw new TypeError('détail interne');
  });
  c.activeId = 1;
  c.accounts = [
    { id: 2, typeCompte: 'F', profile: { eleves: 'oops' as never } },
    { id: 1, typeCompte: 'E', prenom: 'Test', photo: 'https://api.ecoledirecte.com/p.jpg', classe: { libelle: '5e' } },
  ];
  const { children } = await c.dashboard();
  assert.equal(children.length, 1);
  assert.ok(children[0]?.error);
  assert.doesNotMatch(children[0]?.error ?? '', /détail interne/);
});

test('devoirs : matières et pièces jointes nulles ignorées', async () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  const c = setup(async (path) =>
    path.endsWith('cahierdetexte.awp?verbe=get')
      ? { code: 200, data: { '2026-11-09': [{ idDevoir: 5, matiere: 'Maths', effectue: false }] } }
      : {
          code: 200,
          data: {
            matieres: [null, { id: 5, matiere: 'Maths', aFaire: { contenu: b64('Exercice'), documents: [null] } }],
          },
        },
  );
  const page = await c.homework(1, { now: new Date('2026-11-07T12:00:00Z') });
  assert.equal(page.homework.length, 1);
  assert.equal(page.homework[0]?.text, 'Exercice');
  assert.deepEqual(page.homework[0]?.documents, []);
});

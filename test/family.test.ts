/**
 * Coffre chiffré, profils de la famille et facteurs de confiance ÉcoleDirecte.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from '../src/server/vault.ts';
import { checkPin, Family, parseSeed } from '../src/server/family.ts';
import { EcoleDirecte, skills } from '../src/server/ecoledirecte.ts';

const temp = () => mkdtempSync(join(tmpdir(), 'o5g-unit-'));

test('le coffre chiffre, détecte une altération et refuse de démarrer sans clé', () => {
  const dir = temp();
  try {
    const vault = new Vault(dir);
    vault.save('family', { secret: 'Léo' });
    assert.doesNotMatch(readFileSync(join(dir, 'family.enc')).toString('latin1'), /Léo/);
    assert.deepEqual(vault.load('family', null), { secret: 'Léo' });
    const bytes = readFileSync(join(dir, 'family.enc'));
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    writeFileSync(join(dir, 'family.enc'), bytes);
    assert.throws(() => vault.load('family', null), /illisible/);
    rmSync(join(dir, 'key'));
    assert.throws(() => new Vault(dir), /Clé du coffre absente/);
    assert.throws(() => vault.load('../key', null), /Nom de document invalide/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('profils initiaux, PIN devinables refusés et rattachement par prénom', () => {
  assert.deepEqual(parseSeed('Camille:parent+admin, Léo:enfant:5e'), [
    { name: 'Camille', role: 'parent', admin: true, grade: '' },
    { name: 'Léo', role: 'child', admin: false, grade: '5e' },
  ]);
  for (const weak of ['000000', '123456', '987654', '12345', 'abcdef']) assert.throws(() => checkPin(weak));
  assert.equal(checkPin('482916'), '482916');
  const dir = temp();
  try {
    const family = new Family(new Vault(dir), 'Alex:parent, Nina:enfant:6e, Malo:enfant:6e');
    assert.equal(family.members.find((m) => m.name === 'Alex')?.admin, true, 'premier parent administrateur');
    assert.equal(new Set(family.members.map((m) => m.color)).size, 3);
    family.autoLink([
      { id: '1:12', name: 'NINA' },
      { id: '1:13', name: 'Malo' },
    ]);
    assert.equal(family.members.find((m) => m.name === 'Nina')?.studentId, '1:12');
    assert.equal(family.members.find((m) => m.name === 'Malo')?.studentId, '1:13');
    // Le seed n'est appliqué qu'une fois : les profils viennent ensuite du coffre.
    const again = new Family(new Vault(dir), 'Autre:parent');
    assert.equal(again.members.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('connexion ÉcoleDirecte avec facteurs de confiance mémorisés', async () => {
  const payloads: Record<string, unknown>[] = [];
  const fetch = (async (url: string, options: { body?: URLSearchParams }) => {
    if (url.includes('gtk=1')) return new Response('', { headers: { 'set-cookie': 'GTK=g; Path=/' } });
    payloads.push(JSON.parse(options.body?.get('data') ?? '{}'));
    return new Response(JSON.stringify({ code: 200, token: 'tok', data: { accounts: [{ id: 1, typeCompte: '1' }] } }));
  }) as unknown as typeof globalThis.fetch;
  const client = new EcoleDirecte(fetch);
  const result = await client.login('parent', 'mdp', [{ cn: 'CN', cv: 'CV' }]);
  assert.equal(result.state, 'authenticated');
  assert.deepEqual(payloads[0]?.fa, [{ cn: 'CN', cv: 'CV' }]);
  assert.equal(payloads[0]?.cn, 'CN');
  assert.deepEqual(client.trusted, [{ cn: 'CN', cv: 'CV' }]);
  assert.equal(client.pending, undefined, 'le mot de passe ne reste pas en mémoire');
});

test('compétences évaluées lues avec leur niveau', () => {
  assert.deepEqual(
    skills([
      { libelleCompetence: 'Raisonner', descriptif: 'Démontrer', valeur: '3' },
      { libelleCompetence: 'Communiquer', valeur: 'Abs' },
      { valeur: '2' },
      null,
    ]),
    [
      { name: 'Raisonner', detail: 'Démontrer', level: 3 },
      { name: 'Communiquer', detail: '', level: null, raw: 'Abs' },
    ],
  );
});

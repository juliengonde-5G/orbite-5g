/**
 * Notes de version et signalements : cohérence de l'historique, règles du coffre
 * de signalements (validation, quota du jour, plafond, droits de lecture).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RELEASES, releasesSince } from '../src/shared/releases.ts';
import { ReportError, Reports } from '../src/server/reports.ts';
import { Vault } from '../src/server/vault.ts';

const parts = (v: string) => v.split('.').map(Number) as [number, number, number];
const newer = (a: string, b: string) => {
  const [x, y] = [parts(a), parts(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

test('la première note de version est celle du package', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string };
  assert.equal(RELEASES[0]?.version, pkg.version);
});

test('les versions sont uniques, de la plus récente à la plus ancienne, avec au moins une note', () => {
  for (let i = 1; i < RELEASES.length; i++) {
    assert.ok(newer(RELEASES[i - 1]!.version, RELEASES[i]!.version) > 0, RELEASES[i]!.version);
    assert.ok(RELEASES[i - 1]!.date >= RELEASES[i]!.date);
  }
  for (const r of RELEASES) {
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(r.notes.length > 0 && r.title);
  }
});

test('releasesSince : rien à la première visite, les versions parues depuis sinon', () => {
  const fake = [
    { version: '1.2.0', date: '2026-11-03', title: 'c', notes: ['x'] },
    { version: '1.1.0', date: '2026-11-02', title: 'b', notes: ['x'] },
    { version: '1.0.0', date: '2026-11-01', title: 'a', notes: ['x'] },
  ];
  assert.deepEqual(releasesSince(null, fake), []);
  assert.deepEqual(
    releasesSince('1.0.0', fake).map((r) => r.version),
    ['1.2.0', '1.1.0'],
  );
  assert.deepEqual(releasesSince('1.2.0', fake), []);
  assert.deepEqual(
    releasesSince('0.9.0', fake).map((r) => r.version),
    ['1.2.0'],
    'une version inconnue n’annonce que la dernière',
  );
});

function withReports(run: (reports: Reports, clock: { now: Date }, vault: Vault) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'orbite-reports-'));
  try {
    const clock = { now: new Date('2026-11-15T10:00:00Z') };
    const vault = new Vault(dir);
    run(new Reports(vault, () => clock.now), clock, vault);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const leo = { id: 'm1', name: 'Léo' };

test('Reports : refuse un type inconnu, un message vide ou trop long', () => {
  withReports((reports) => {
    assert.throws(() => reports.add(leo, { kind: 'autre', text: 'Ça ne marche pas' }, '1.5.0'), ReportError);
    assert.throws(() => reports.add(leo, { kind: 'bug', text: '   ' }, '1.5.0'), ReportError);
    assert.throws(() => reports.add(leo, { kind: 'bug', text: 'x'.repeat(1001) }, '1.5.0'), ReportError);
    assert.equal(reports.list().length, 0);
  });
});

test('Reports : texte nettoyé, écran limité à un mot simple, aucun identifiant de membre en sortie', () => {
  withReports((reports) => {
    reports.add(
      leo,
      { kind: 'bug', text: '  Les notes\n\n ne    s’affichent pas ', screen: '../etc<script>' },
      '1.5.0',
    );
    const [item] = reports.list();
    assert.equal(item?.text, 'Les notes ne s’affichent pas');
    assert.equal(item?.screen, 'accueil');
    assert.equal(item?.by, 'Léo');
    assert.equal(item?.version, '1.5.0');
    assert.ok(!('memberId' in item!), 'l’identifiant du profil reste dans le coffre');
  });
});

test('Reports : cinq par membre et par jour, le compteur repart le lendemain', () => {
  withReports((reports, clock) => {
    for (let i = 0; i < 5; i++) reports.add(leo, { kind: 'idea', text: `Idée numéro ${i}` }, '1.5.0');
    assert.throws(
      () => reports.add(leo, { kind: 'idea', text: 'Une de plus' }, '1.5.0'),
      (e: unknown) => e instanceof ReportError && e.code === 429,
    );
    reports.add({ id: 'm2', name: 'Nina' }, { kind: 'idea', text: 'Autre profil, autre quota' }, '1.5.0');
    clock.now = new Date('2026-11-16T10:00:00Z');
    reports.add(leo, { kind: 'idea', text: 'Le lendemain' }, '1.5.0');
    assert.equal(reports.list().length, 7);
  });
});

test('Reports : ouverts d’abord, traité / rouvert / supprimé, plafond de deux cents', () => {
  withReports((reports, clock) => {
    reports.add(leo, { kind: 'bug', text: 'Premier problème' }, '1.5.0');
    clock.now = new Date('2026-11-15T11:00:00Z');
    reports.add(leo, { kind: 'question', text: 'Deuxième message' }, '1.5.0');
    let [second, first] = reports.list();
    assert.equal(second?.text, 'Deuxième message', 'le plus récent d’abord');
    reports.resolve(second!.id, true);
    assert.equal(reports.open(), 1);
    assert.deepEqual(
      reports.list().map((r) => r.done),
      [false, true],
      'les traités passent après les ouverts',
    );
    reports.resolve(second!.id, false);
    assert.equal(reports.open(), 2);
    assert.throws(
      () => reports.resolve('inconnu', true),
      (e: unknown) => e instanceof ReportError && e.code === 404,
    );
    reports.remove(first!.id);
    assert.equal(reports.list().length, 1);
    assert.throws(() => reports.remove(first!.id), ReportError);

    // Plafond : au-delà de 200, le plus ancien traité part d'abord.
    reports.resolve(second!.id, true);
    for (let d = 0; d < 41; d++) {
      clock.now = new Date(Date.UTC(2026, 11, 1 + d, 10));
      for (let i = 0; i < 5; i++) reports.add(leo, { kind: 'idea', text: `Jour ${d} numéro ${i}` }, '1.5.0');
    }
    assert.equal(reports.list().length, 200);
    assert.ok(!reports.list().some((r) => r.text === 'Deuxième message'), 'le traité le plus ancien a été retiré');
  });
});

test('Reports : survit au redémarrage', () => {
  withReports((reports, clock, vault) => {
    reports.add(leo, { kind: 'bug', text: 'Je reste dans le coffre' }, '1.5.0');
    const again = new Reports(vault, () => clock.now);
    assert.equal(again.list()[0]?.text, 'Je reste dans le coffre');
  });
});

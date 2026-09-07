// Adversarial comment sweep (waves 20-22): commented-out code is neither
// signal nor escape hatch — except the migration backup-reference hatch,
// which deliberately reads comments (SQL has no uncommented metadata
// channel; documented in the rule header). File-based probes only:
// an earlier inline-shell sweep gave a false all-clear via mangled
// quoting, so every case here is an exact diff string.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRules } from '../lib/review.js';

const rules = await loadRules('1.4.0');
const byId = Object.fromEntries(rules.map((r) => [r.ruleId, r.check]));

function diff(path, plus) {
  return (
    `diff --git a/${path} b/${path}\n` +
    'index 111..222 100644\n' +
    `--- a/${path}\n` +
    `+++ b/${path}\n` +
    '@@ -1,2 +1,10 @@\n' +
    ' ok();\n' + plus + '\n done();\n'
  );
}

test('adversarial: commented JS signals stay silent', () => {
  const d = diff(
    'src/x.js',
    [
      '+// process.exit(1);',
      '+// eval(userInput);',
      '+// require("child_process").execSync(cmd);',
      '+// fetch(url).catch(() => fetch(url));',
      '+// var old = 1;',
      '+// if (a == b) {}',
      '+// console.log("debug");',
      '+// fs.readFileSync(p);',
    ].join('\n'),
  );
  for (const [id, check] of Object.entries(byId)) {
    assert.equal(check(d).length, 0, `${id} fired on commented JS`);
  }
});

test('adversarial: commented SQL signals stay silent', () => {
  const d = diff(
    'migrations/001.sql',
    [
      '+-- DROP TABLE users;',
      '+-- TRUNCATE sessions;',
      '+-- DELETE FROM orders;',
      '+-- UPDATE accounts SET admin = true;',
    ].join('\n'),
  );
  for (const id of [
    'no-destructive-sql-without-guard',
    'require-where-on-delete-update',
    'no-destructive-migration-without-backup-verification',
  ]) {
    assert.equal(byId[id](d).length, 0, `${id} fired on commented SQL`);
  }
});

test('adversarial: commented WHERE guards nothing', () => {
  const d = diff(
    'migrations/002.sql',
    ['+DELETE FROM sessions;', '+-- WHERE expired_at < NOW();', '+SELECT 1;'].join('\n'),
  );
  assert.equal(
    byId['require-where-on-delete-update'](d).length, 1,
    'commented WHERE must not guard a live DELETE',
  );
});

test('adversarial: commented probe is not a probe, commented image is not code', () => {
  const bypass = diff(
    'k8s/a.yaml',
    ['+      - image: registry/web:v2', '+#        readinessProbe: TODO'].join('\n'),
  );
  assert.equal(
    byId['require-health-check-before-traffic-shift'](bypass).length, 1,
    'commented probe must not silence the rule',
  );
  const fp = diff(
    'k8s/b.yaml',
    ['+#      - image: registry/retired:v1', '+  text: history'].join('\n'),
  );
  assert.equal(
    byId['require-health-check-before-traffic-shift'](fp).length, 0,
    'commented image must not fire',
  );
});

test('adversarial: commented workflow steps never execute', () => {
  const d = diff(
    '.github/workflows/ci.yml',
    ['+      # - uses: actions/checkout@v4', '+      - run: npm test'].join('\n'),
  );
  assert.equal(
    byId['no-unpinned-github-action-ref'](d).length, 0,
    'commented uses: must not fire',
  );
});

test('adversarial: secrets are data, not instructions — comments still leak', () => {
  // A commented-out credential or key is still in git history and must be
  // rotated: these two rules deliberately fire on comments (wave-23).
  const cicd = diff(
    '.github/workflows/deploy.yml',
    ['+# password: s3cr3t-value'].join('\n'),
  );
  assert.equal(
    byId['no-secrets-in-cicd-config'](cicd).length, 1,
    'commented workflow secret must still fire',
  );
  // NOTE: armor line is assembled at runtime so this file itself never
  // contains key material (a literal here would — correctly — fire the
  // rule on this very diff, as dogfood wave-23 proved).
  const armor = '+# -----BEGIN ' + 'RSA PRIVATE KEY-----';
  const key = diff('src/auth.js', [armor].join('\n'));
  assert.equal(
    byId['no-private-key-in-diff'](key).length, 1,
    'commented key material must still fire',
  );
});

test('adversarial: migration backup hatch still reads comments (documented contract)', () => {
  const d = diff(
    'db/migrations/043_x.sql',
    [
      '+-- Verified backup: pg_dump users to s3://backups/u.dump',
      '+ALTER TABLE users DROP COLUMN legacy_email;',
    ].join('\n'),
  );
  assert.equal(
    byId['no-destructive-migration-without-backup-verification'](d).length, 0,
    'commented backup reference remains a valid hatch',
  );
});

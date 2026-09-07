import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const RULES = [
  'no-unauthenticated-api-endpoints',
  'no-secrets-in-cicd-config',
  'require-transaction-rollback-on-failure',
  'no-unindexed-schema-migration-on-large-tables',
  'no-n-plus-one-queries-in-api-resolvers',
  'no-destructive-migration-without-backup-verification',
  'no-swallowed-exceptions-in-critical-path',
  'require-dataloader-or-eager-load-for-nested-fetches',
  'no-eval-with-dynamic-input',
  'no-disabled-tls-verification',
  'no-private-key-in-diff',
  'no-unpinned-github-action-ref',
  'no-process-exit-in-server-code',
  'no-hardcoded-localhost-url-in-diff',
  'require-lockfile-update-with-manifest-change',
  'no-destructive-sql-without-guard',
  'require-where-on-delete-update',
  'no-unbounded-list-query-without-pagination',
  'no-sync-io-in-route-handler',
  'require-strict-equality',
  'no-var-instead-of-let-const',
  'no-console-log-in-server-diff',
  'require-retry-with-backoff-for-transient-failures',
  'require-health-check-before-traffic-shift',
];

for (const ruleId of RULES) {
  const mod = await import(`../lib/rules/${ruleId}.js`);
  const check = mod.check;
  const posPath = join(__dirname, 'fixtures', ruleId, 'positive.diff');
  const negPath = join(__dirname, 'fixtures', ruleId, 'negative.diff');
  const posDiff = readFileSync(posPath, 'utf8');
  const negDiff = readFileSync(negPath, 'utf8');

  test(`${ruleId}: positive fixture fires ≥1 finding`, () => {
    const findings = check(posDiff);
    assert.ok(findings.length >= 1, `expected ≥1 finding, got ${findings.length}`);
    assert.equal(findings[0].ruleId, ruleId);
    assert.ok(typeof findings[0].file === 'string');
    assert.ok(typeof findings[0].line === 'number');
  });

  test(`${ruleId}: negative fixture fires 0 findings`, () => {
    const findings = check(negDiff);
    assert.equal(findings.length, 0, `expected 0 findings, got ${findings.length}: ${JSON.stringify(findings)}`);
  });
}

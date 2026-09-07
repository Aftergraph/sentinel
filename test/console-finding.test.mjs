import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createConsoleServer } from '../console/server.js';

const CLEAN_DIFF = `diff --git a/README.md b/README.md
index 1111111..2222222 100644
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-old
+new
`;

const EVAL_DIFF = `diff --git a/srv/app.js b/srv/app.js
index 1111111..2222222 100644
--- a/srv/app.js
+++ b/srv/app.js
@@ -1,3 +1,4 @@
 export function run(input) {
+  return eval(input);
 }
`;

async function boot(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-finding-'));
  const handler = createConsoleServer({
    ledgerPath: join(dir, 'ledger.jsonl'),
    memoryPath: join(dir, 'mem.jsonl'),
    // Hermetic: never discover cwd config (a stray file would poison results).
    configPath: join(dir, 'sentinel.config.json'),
    ...opts,
  });
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    dir,
    async call(method, path, body, headers = {}) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: await res.json() };
    },
    async text(path, headers = {}) {
      const res = await fetch(`${base}${path}`, { headers });
      return { status: res.status, body: await res.text() };
    },
    async close() {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function postEval(c, extra = {}) {
  const posted = await c.call('POST', '/api/review', { diff: EVAL_DIFF, repo: 'o/r', pr: 7, ...extra });
  assert.equal(posted.status, 200);
  assert.equal(posted.json.verdict, 'DO_NOT_SHIP');
  const pr = await c.call('GET', '/api/pr/o%2Fr/7');
  assert.equal(pr.status, 200);
  const f = pr.json.blocking[0];
  assert.equal(f.ruleId, 'no-eval-with-dynamic-input');
  return f;
}

test('finding: record shape resolves one finding from the latest receipt', async () => {
  const c = await boot();
  try {
    const f = await postEval(c);
    const path = `/api/finding/o%2Fr/7/${encodeURIComponent(f.ruleId)}/${f.line}`;
    const { status, json } = await c.call('GET', path);
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(json).sort(), [
      'evidence', 'finding', 'headSha', 'history', 'prNumber', 'repo', 'stale', 'verdict',
    ]);
    assert.equal(json.repo, 'o/r');
    assert.equal(json.prNumber, 7);
    assert.equal(json.verdict, 'DO_NOT_SHIP');
    assert.equal(json.stale, false);

    assert.deepEqual(Object.keys(json.finding).sort(), [
      'aiConfidence', 'blocking', 'evidence', 'evidenceRefs', 'file', 'line',
      'ruleId', 'severity', 'verificationState',
    ]);
    assert.equal(json.finding.ruleId, 'no-eval-with-dynamic-input');
    assert.equal(json.finding.severity, 'security');
    assert.equal(json.finding.file, 'srv/app.js');
    assert.equal(json.finding.line, f.line);
    assert.ok(typeof json.finding.evidence === 'string' && json.finding.evidence.length > 0);
    assert.equal(json.finding.blocking, true);
    assert.ok('aiConfidence' in json.finding);
    assert.ok('verificationState' in json.finding);
    assert.ok(Array.isArray(json.finding.evidenceRefs));

    // Evidence lists only sealed items matching this finding's refs.
    assert.ok(Array.isArray(json.evidence));
    const refSet = new Set(json.finding.evidenceRefs);
    for (const e of json.evidence) {
      assert.ok(typeof e.id === 'string' && e.id.length > 0);
      assert.ok(typeof e.hash === 'string' && e.hash.length > 0);
      assert.ok(refSet.has(e.id), `evidence ${e.id} not in evidenceRefs`);
    }
    assert.equal(json.evidence.length, refSet.size);

    // Bare-slash repo path resolves to the same record.
    const bare = await c.call('GET', `/api/finding/o/r/7/${encodeURIComponent(f.ruleId)}/${f.line}`);
    assert.equal(bare.status, 200);
    assert.deepEqual(bare.json, json);

    // History covers the single receipt so far.
    assert.equal(json.history.length, 1);
    assert.equal(json.history[0].headSha, json.headSha);
  } finally { await c.close(); }
});

test('finding: 404 when absent, 400 on malformed path', async () => {
  const c = await boot();
  try {
    const f = await postEval(c);
    const base = `/api/finding/o%2Fr/7/${encodeURIComponent(f.ruleId)}`;
    // Unknown rule / unknown line / unknown PR: 404.
    assert.equal((await c.call('GET', `${base}/9999`)).status, 404);
    assert.equal((await c.call('GET', `/api/finding/o%2Fr/7/no-such-rule/${f.line}`)).status, 404);
    assert.equal((await c.call('GET', `/api/finding/no%2Fpe/9/${encodeURIComponent(f.ruleId)}/${f.line}`)).status, 404);
    // Truncated paths: 400.
    assert.equal((await c.call('GET', '/api/finding')).status, 400);
    assert.equal((await c.call('GET', '/api/finding/onlyrepo')).status, 400);
    assert.equal((await c.call('GET', '/api/finding/o%2Fr/7')).status, 400);
    assert.equal((await c.call('GET', base)).status, 400);
    // Non-integer line: 400.
    assert.equal((await c.call('GET', `${base}/abc`)).status, 400);
    assert.equal((await c.call('GET', `${base}/1.5`)).status, 400);
  } finally { await c.close(); }
});

test('finding: gone from latest receipt 404s', async () => {
  const c = await boot();
  try {
    const f = await postEval(c);
    const path = `/api/finding/o%2Fr/7/${encodeURIComponent(f.ruleId)}/${f.line}`;
    assert.equal((await c.call('GET', path)).status, 200);
    // A clean review supersedes it: the finding is absent from latest.
    const clean = await c.call('POST', '/api/review', { diff: CLEAN_DIFF, repo: 'o/r', pr: 7 });
    assert.equal(clean.status, 200);
    assert.equal((await c.call('GET', path)).status, 404);
  } finally { await c.close(); }
});

test('finding: token gate enforced on the new route', async () => {
  const c = await boot({ token: 'tok' });
  const auth = { authorization: ['Bearer', 'tok'].join(' ') };
  try {
    await c.call('POST', '/api/review', { diff: EVAL_DIFF, repo: 'o/r', pr: 7 }, auth);
    const pr = await c.call('GET', '/api/pr/o%2Fr/7', undefined, auth);
    const f = pr.json.blocking[0];
    const path = `/api/finding/o%2Fr/7/${encodeURIComponent(f.ruleId)}/${f.line}`;
    assert.equal((await c.call('GET', path)).status, 401);
    const authed = await c.call('GET', path, undefined, auth);
    assert.equal(authed.status, 200);
    assert.equal(authed.json.finding.ruleId, 'no-eval-with-dynamic-input');
  } finally { await c.close(); }
});

test('finding: AI-vs-verified panel separation present in served output', async () => {
  const c = await boot();
  try {
    const page = await c.text('/');
    assert.equal(page.status, 200);
    assert.ok(page.body.includes('#/finding'));

    const js = await c.text('/app.js');
    assert.equal(js.status, 200);
    assert.ok(js.body.includes('/api/finding/'));
    assert.ok(js.body.includes('#/finding'));
    // Detail pane: severity icon+label, WHY with location, blast radius,
    // suggestion-framed fix, history timeline.
    assert.ok(js.body.includes('aria-label="severity'));
    assert.ok(js.body.includes('Why this fired'));
    assert.ok(js.body.includes('Code location:'));
    assert.ok(js.body.includes('Blast radius'));
    assert.ok(js.body.includes('Suggested fix'));
    assert.ok(js.body.includes('Suggestion (not an instruction):'));
    assert.ok(js.body.includes('History'));
    // AI-confidence apart from verification, each in its own labeled panel.
    assert.ok(js.body.includes('AI estimate'));
    assert.ok(js.body.includes('Verified evidence'));
    assert.ok(js.body.includes('finding-ai'));
    assert.ok(js.body.includes('finding-verified'));
    assert.ok(js.body.includes('model estimate, not evidence'));
    // Brand law: no color-only verdict styling sneaks in with the new view.
    for (const re of [/color\s*:\s*red/i, /color\s*:\s*green/i, /color\s*:\s*orange/i, /background\s*:\s*red/i, /background\s*:\s*green/i]) {
      assert.ok(!re.test(js.body), `color-only styling: ${re}`);
    }

    const css = await c.text('/styles.css');
    assert.equal(css.status, 200);
    assert.ok(css.body.includes('.finding-ai'));
    assert.ok(css.body.includes('.finding-verified'));
    // Panels never share a color: AI is purple, verified is green.
    const aiBlock = css.body.match(/\.finding-ai\s*\{[^}]*\}/)[0];
    const verBlock = css.body.match(/\.finding-verified\s*\{[^}]*\}/)[0];
    assert.ok(aiBlock.includes('--purple'), 'AI panel must be purple');
    assert.ok(!aiBlock.includes('--green') && !aiBlock.includes('--cyan'), 'AI panel must not use the verified color');
    assert.ok(verBlock.includes('--green') || verBlock.includes('--cyan'), 'verified panel must be cyan/green');
    assert.ok(!verBlock.includes('--purple'), 'verified panel must not use the AI color');
    assert.ok(css.body.includes('@media (prefers-reduced-motion: reduce)'));
  } finally { await c.close(); }
});

test('finding: history spans two heads', async () => {
  const H1 = 'a'.repeat(40);
  const H2 = 'b'.repeat(40);
  const c = await boot();
  try {
    const posted1 = await c.call('POST', '/api/review', { diff: EVAL_DIFF, repo: 'o/r', pr: 8, headSha: H1 });
    assert.equal(posted1.status, 200);
    const posted2 = await c.call('POST', '/api/review', { diff: EVAL_DIFF, repo: 'o/r', pr: 8, headSha: H2 });
    assert.equal(posted2.status, 200);
    const pr = await c.call('GET', '/api/pr/o%2Fr/8');
    const f = pr.json.blocking.find((g) => g.ruleId === 'no-eval-with-dynamic-input');
    assert.ok(f);
    const { status, json } = await c.call('GET', `/api/finding/o%2Fr/8/${encodeURIComponent(f.ruleId)}/${f.line}`);
    assert.equal(status, 200);
    assert.equal(json.headSha, H2);
    assert.equal(json.history.length, 2);
    assert.deepEqual(json.history.map((h) => h.headSha), [H1, H2]);
    assert.deepEqual(json.history.map((h) => h.seq), [1, 2]);
    for (const h of json.history) {
      assert.ok(h.receiptId);
      assert.ok(h.timestamp);
    }
  } finally { await c.close(); }
});

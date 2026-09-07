import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createConsoleServer } from '../console/server.js';
import { planChecks } from '../lib/verify.js';

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

const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);

async function boot(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-verify-'));
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

// Reviews H1, then starts a run for the first blocking finding of repo+pr.
async function setupRun(c, repo = 'o/v', pr = 7, head = H1, diff = EVAL_DIFF) {
  const posted = await c.call('POST', '/api/review', { diff, repo, pr, headSha: head });
  assert.equal(posted.status, 200);
  const prec = await c.call('GET', `/api/pr/${encodeURIComponent(repo)}/${pr}`);
  assert.equal(prec.status, 200);
  assert.ok(prec.json.blocking.length >= 1);
  const f = prec.json.blocking[0];
  const started = await c.call('POST', '/api/verify/start', {
    repo, prNumber: pr, ruleId: f.ruleId, line: f.line,
  });
  return { posted, finding: f, started };
}

test('verify: start happy path plans checks via lib with ledger head', async () => {
  const c = await boot();
  try {
    const { posted, finding, started } = await setupRun(c);
    assert.equal(started.status, 200);
    const run = started.json;
    assert.match(run.id, /^VR-\d{4}$/);
    assert.equal(run.status, 'PENDING');
    assert.equal(run.targetSha, H1);
    assert.equal(run.targetSha, posted.json.review.headSha);
    assert.deepEqual(run.findingRef, { repo: 'o/v', prNumber: 7, ruleId: finding.ruleId, line: finding.line });
    assert.deepEqual(run.checks.map((x) => x.type), planChecks({ ruleId: finding.ruleId }));
    assert.ok(run.checks.length > 0);
    for (const x of run.checks) assert.equal(x.status, 'PENDING');
    assert.deepEqual(run.progress, { done: 0, total: run.checks.length });
    assert.ok(Array.isArray(run.evidenceIds));
    assert.equal(run.stale, false);
  } finally { await c.close(); }
});

test('verify: unknown finding and unknown run 404; bad body 400s', async () => {
  const c = await boot();
  try {
    const { finding } = await setupRun(c);
    const badRule = await c.call('POST', '/api/verify/start', {
      repo: 'o/v', prNumber: 7, ruleId: 'no-such-rule', line: finding.line,
    });
    assert.equal(badRule.status, 404);
    const badLine = await c.call('POST', '/api/verify/start', {
      repo: 'o/v', prNumber: 7, ruleId: finding.ruleId, line: 999999,
    });
    assert.equal(badLine.status, 404);
    const badPr = await c.call('POST', '/api/verify/start', {
      repo: 'o/v', prNumber: 4242, ruleId: finding.ruleId, line: finding.line,
    });
    assert.equal(badPr.status, 404);
    assert.equal((await c.call('POST', '/api/verify/start', { repo: 'o/v' })).status, 400);
    assert.equal((await c.call('GET', '/api/verify/VR-9999')).status, 404);
    assert.equal((await c.call('GET', '/api/verify/')).status, 404);
  } finally { await c.close(); }
});

test('verify: run shape and progress math', async () => {
  const c = await boot();
  try {
    const { started } = await setupRun(c);
    const { status, json } = await c.call('GET', `/api/verify/${started.json.id}`);
    assert.equal(status, 200);
    for (const k of ['id', 'findingRef', 'targetSha', 'status', 'progress', 'checks', 'evidenceIds']) {
      assert.ok(k in json, `missing key ${k}`);
    }
    assert.equal(json.id, started.json.id);
    assert.deepEqual(json.findingRef, started.json.findingRef);
    assert.equal(json.targetSha, H1);
    assert.equal(json.status, 'PENDING');
    assert.equal(json.progress.total, json.checks.length);
    assert.equal(json.progress.done, 0);
    assert.ok(json.progress.done <= json.progress.total);
    for (const x of json.checks) {
      assert.deepEqual(Object.keys(x).sort(), ['status', 'type']);
      assert.equal(typeof x.type, 'string');
      assert.equal(x.status, 'PENDING');
    }
  } finally { await c.close(); }
});

test('verify: STALE flips on head drift after a second review', async () => {
  const c = await boot();
  try {
    const { started } = await setupRun(c);
    const fresh = await c.call('GET', `/api/verify/${started.json.id}`);
    assert.equal(fresh.json.stale, false);
    assert.equal(fresh.json.ledgerHead, H1);

    const second = await c.call('POST', '/api/review', { diff: CLEAN_DIFF, repo: 'o/v', pr: 7, headSha: H2 });
    assert.equal(second.status, 200);

    const drift = await c.call('GET', `/api/verify/${started.json.id}`);
    assert.equal(drift.status, 200);
    assert.equal(drift.json.stale, true);
    assert.equal(drift.json.ledgerHead, H2);
    // The run itself is unchanged — only the drift flag flips.
    assert.equal(drift.json.targetSha, H1);
    assert.ok(drift.json.staleReason.includes(H1));
    assert.ok(drift.json.staleReason.includes(H2));
  } finally { await c.close(); }
});

test('verify: token gate enforced on the new routes', async () => {
  const c = await boot({ token: 'tok' });
  const auth = { authorization: 'Bearer tok' };
  try {
    await c.call('POST', '/api/review', { diff: EVAL_DIFF, repo: 'o/v', pr: 7, headSha: H1 }, auth);
    const prec = await c.call('GET', '/api/pr/o%2Fv/7', undefined, auth);
    const f = prec.json.blocking[0];
    assert.equal((await c.call('POST', '/api/verify/start', {
      repo: 'o/v', prNumber: 7, ruleId: f.ruleId, line: f.line,
    })).status, 401);
    const started = await c.call('POST', '/api/verify/start', {
      repo: 'o/v', prNumber: 7, ruleId: f.ruleId, line: f.line,
    }, auth);
    assert.equal(started.status, 200);
    assert.equal((await c.call('GET', `/api/verify/${started.json.id}`)).status, 401);
    const authed = await c.call('GET', `/api/verify/${started.json.id}`, undefined, auth);
    assert.equal(authed.status, 200);
    assert.equal(authed.json.id, started.json.id);
  } finally { await c.close(); }
});

test('verify: brand-law tokens and polling semantics in served output', async () => {
  const c = await boot();
  try {
    const page = await c.text('/');
    assert.equal(page.status, 200);
    assert.ok(page.body.includes('#/verify'));

    const js = await c.text('/app.js');
    assert.equal(js.status, 200);
    assert.ok(js.body.includes('/api/verify/start'));
    assert.ok(js.body.includes('/api/verify/'));
    // Plain polling, no websockets.
    assert.ok(js.body.includes('setInterval'));
    assert.ok(!js.body.includes('WebSocket'));
    // Progress bar n/m with a live status node.
    assert.ok(js.body.includes('<progress'));
    assert.ok(js.body.includes('checks complete'));
    assert.ok(js.body.includes('role="status"'));
    // Per-check rows: icon+label+text across pending→running→pass/fail.
    for (const word of ['pending', 'running', 'pass', 'fail']) {
      assert.ok(js.body.includes(word), `missing check label ${word}`);
    }
    assert.ok(js.body.includes('verify-check'));
    // Linked sealed-evidence list + STALE banner on head drift.
    assert.ok(js.body.includes('verify-evidence'));
    assert.ok(js.body.includes('sealed evidence'));
    assert.ok(js.body.includes('◐ STALE'));
    // Semantic list markup, keyboard-reachable native controls.
    assert.ok(js.body.includes('<ul'));
    assert.ok(js.body.includes('<button'));
    for (const re of [/color\s*:\s*red/i, /color\s*:\s*green/i, /color\s*:\s*orange/i, /background\s*:\s*red/i, /background\s*:\s*green/i]) {
      assert.ok(!re.test(js.body), `color-only verdict styling: ${re}`);
    }

    const css = await c.text('/styles.css');
    assert.equal(css.status, 200);
    assert.ok(css.body.includes('.verify-'));
    assert.ok(css.body.includes('.verify-progress'));
    assert.ok(css.body.includes('.verify-check'));
    assert.ok(css.body.includes('var(--green)'));
    assert.ok(css.body.includes('var(--red)'));
    assert.ok(css.body.includes('var(--orange)'));
    assert.ok(css.body.includes('var(--gray)'));
    assert.ok(css.body.includes('var(--purple)'));
    assert.ok(css.body.includes('@media (prefers-reduced-motion: reduce)'));
  } finally { await c.close(); }
});

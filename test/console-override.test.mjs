import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createConsoleServer } from '../console/server.js';

const HEAD_C = 'c'.repeat(40);
const HEAD_D = 'd'.repeat(40);

function baseReceipt(over = {}) {
  return {
    contract: 'sentinel.receipt/0.1',
    repo: 'o/r',
    prNumber: 7,
    headSha: HEAD_C,
    baseSha: HEAD_D,
    rulePackVersion: 'v1',
    verdict: 'SHIP',
    findings: { blocking: [], silenced: [], nonBlocking: [], excluded: [] },
    counts: { blocking: 0, silenced: 0, nonBlocking: 0, excluded: 0 },
    configHash: null,
    receipt_id: 'aaa',
    prev_receipt_id: null,
    run_id: 'run-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    source: 'manual',
    environment: null,
    ...over,
  };
}

async function boot(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-override-'));
  const ledgerPath = join(dir, 'ledger.jsonl');
  const handler = createConsoleServer({
    ledgerPath,
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
    ledgerPath,
    seed(rec) {
      appendFileSync(ledgerPath, `${JSON.stringify(rec)}\n`);
    },
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

// Execute the SHIPPED prPanels (sliced from served app.js with its pure
// deps esc/short/pill — no DOM at definition time) against a record.
function servedPrPanels(appJs) {
  const start = appJs.indexOf('const esc = ');
  const end = appJs.indexOf('\nfunction renderPrTabs');
  assert.ok(start !== -1 && end > start, 'served app.js must carry prPanels before renderPrTabs');
  return vm.runInNewContext(`${appJs.slice(start, end)}; prPanels;`);
}

const OVERRIDDEN = { actor: 'alice', reason: 'incident-123', from: 'DO_NOT_SHIP', to: 'SHIP' };
const POLICY = {
  policyVersion: 'my-policy@abcdef1234567890',
  verdict: 'BLOCKED',
  reasons: ['missing required check: "ci/unit"'],
};

test('override: PR record carries overridden{actor,reason,from}+policyEvaluation from the receipt', async () => {
  const c = await boot();
  try {
    c.seed(baseReceipt({
      prNumber: 8,
      verdict: 'SHIP',
      overridden: OVERRIDDEN,
      overriddenFrom: 'DO_NOT_SHIP',
      policyEvaluation: POLICY,
    }));
    const { status, json } = await c.call('GET', '/api/pr/o%2Fr/8');
    assert.equal(status, 200);
    assert.deepEqual(json.overridden, OVERRIDDEN);
    assert.equal(json.overridden.actor, 'alice');
    assert.equal(json.overridden.reason, 'incident-123');
    assert.equal(json.overridden.from, 'DO_NOT_SHIP');
    assert.equal(json.overriddenFrom, 'DO_NOT_SHIP');
    assert.deepEqual(json.policyEvaluation, POLICY);
    assert.equal(json.verdict, 'SHIP');
  } finally { await c.close(); }
});

test('override: plain record omits override/policy keys (no empty banner data)', async () => {
  const c = await boot();
  try {
    c.seed(baseReceipt({ prNumber: 7 }));
    const { status, json } = await c.call('GET', '/api/pr/o%2Fr/7');
    assert.equal(status, 200);
    assert.ok(!('overridden' in json), 'plain record must not carry overridden');
    assert.ok(!('overriddenFrom' in json), 'plain record must not carry overriddenFrom');
    assert.ok(!('policyEvaluation' in json), 'plain record must not carry policyEvaluation');
  } finally { await c.close(); }
});

test('override: served PR view renders OVERRIDDEN banner + was-line + policy line, amber and escaped', async () => {
  const c = await boot();
  try {
    c.seed(baseReceipt({ prNumber: 7 }));
    c.seed(baseReceipt({
      prNumber: 8,
      receipt_id: 'bbb',
      prev_receipt_id: 'aaa',
      verdict: 'SHIP',
      overridden: OVERRIDDEN,
      overriddenFrom: 'DO_NOT_SHIP',
      policyEvaluation: POLICY,
    }));
    // Seeded HTML-injection override: the view must escape actor/reason.
    c.seed(baseReceipt({
      prNumber: 9,
      receipt_id: 'ccc',
      overridden: { actor: '<script>alert(1)</script>', reason: 'a&b"c', from: 'DO_NOT_SHIP', to: 'SHIP' },
      overriddenFrom: 'DO_NOT_SHIP',
    }));

    const js = await c.text('/app.js');
    assert.equal(js.status, 200);
    assert.ok(js.body.includes('override-banner'), 'PR view must render an override banner');
    assert.ok(js.body.includes('OVERRIDDEN'), 'banner carries the OVERRIDDEN label (never color-only)');

    const prPanels = servedPrPanels(js.body);

    const plain = (await c.call('GET', '/api/pr/o%2Fr/7')).json;
    const over = (await c.call('GET', '/api/pr/o%2Fr/8')).json;
    const evil = (await c.call('GET', '/api/pr/o%2Fr/9')).json;

    // Overridden receipt: banner + was-line + policy line.
    const html = prPanels(over).Overview;
    assert.ok(html.includes('override-banner'), 'overridden record renders the banner');
    assert.ok(html.includes('OVERRIDDEN'), 'banner carries icon+label+text');
    assert.ok(html.includes('by alice'), 'banner names the actor');
    assert.ok(html.includes('incident-123'), 'banner carries the reason');
    assert.ok(html.includes('was DO_NOT_SHIP'), 'banner carries the was-line');
    assert.ok(
      html.includes('policy my-policy@abcdef1234567890 BLOCKED'),
      'policy line renders `policy <name>@<hash> <verdict>`',
    );

    // Plain receipt: absent cleanly — no empty banner, no policy line.
    const plainHtml = prPanels(plain).Overview;
    assert.ok(!plainHtml.includes('override-banner'), 'plain record renders no banner');
    assert.ok(!plainHtml.includes('OVERRIDDEN'), 'plain record mentions no override');
    assert.ok(!plainHtml.includes('policy '), 'plain record renders no policy line');

    // VibeSec: actor/reason/version flow through esc().
    const evilHtml = prPanels(evil).Overview;
    assert.ok(!evilHtml.includes('<script>alert(1)</script>'), 'actor must be escaped');
    assert.ok(evilHtml.includes('&lt;script&gt;'), 'escaped actor visible as text');
    assert.ok(evilHtml.includes('a&amp;b&quot;c'), 'reason metacharacters escaped');

    // Brand law: amber override, never red/green confusion.
    const css = await c.text('/styles.css');
    assert.equal(css.status, 200);
    const block = css.body.match(/\.override-banner\s*\{[^}]*\}/);
    assert.ok(block, 'styles carry .override-banner');
    assert.ok(block[0].includes('--orange'), 'override banner is amber');
    assert.ok(!block[0].includes('--red') && !block[0].includes('--green'), 'override is attention, not failure/success');
    for (const re of [/color\s*:\s*red/i, /color\s*:\s*green/i, /background\s*:\s*red/i, /background\s*:\s*green/i]) {
      assert.ok(!re.test(js.body), `color-only verdict styling: ${re}`);
    }
  } finally { await c.close(); }
});

test('override: token gate 401/200 on the touched PR route', async () => {
  const c = await boot({ token: 'sekrit' });
  try {
    c.seed(baseReceipt({ prNumber: 7 }));
    const auth = { authorization: 'Bearer sekrit' };
    assert.equal((await c.call('GET', '/api/pr/o%2Fr/7')).status, 401);
    const authed = await c.call('GET', '/api/pr/o%2Fr/7', undefined, auth);
    assert.equal(authed.status, 200);
    assert.equal(authed.json.repo, 'o/r');
    assert.ok(!('overridden' in authed.json));
  } finally { await c.close(); }
});

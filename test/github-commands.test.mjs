import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCommand, authorize, helpText, whyText, REPLY_MARKER } from '../apps/github/commands.js';
import { routeEvent } from '../apps/github/app.js';
import { ruleIdsForPack } from '../lib/rulepack.js';

const H = 'a'.repeat(40);
const B = 'c'.repeat(40);
const DIFF = 'diff --git a/README.md b/README.md\nindex 1..2 100644\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n';

function platform() {
  const calls = [];
  return {
    calls,
    async getPR() { return { head: { sha: H }, base: { sha: B } }; },
    async getDiff() { return DIFF; },
    async listComments() { return []; },
    async postComment(repo, pr, body) { calls.push({ op: 'post', repo, pr, body }); return { id: 1 }; },
    async patchComment(repo, id, body) { calls.push({ op: 'patch', id, body }); },
  };
}
function payload(body, { assoc = 'MEMBER', type = 'User', login = 'jonas', pr = true, action = 'created' } = {}) {
  return {
    action,
    repository: { full_name: 'Aftergraph/x' },
    issue: { number: 7, ...(pr ? { pull_request: { url: 'u' } } : {}) },
    comment: { body, author_association: assoc, user: { login, type } },
  };
}
function opts() { const d = mkdtempSync(join(tmpdir(), 'sc-')); return { d, o: { ledgerPath: join(d, 'l.jsonl'), memoryPath: join(d, 'm.json') } }; }

test('parseCommand recognises handles, verbs and ignores other text', () => {
  assert.deepEqual(parseCommand('@sentinel review'), { cmd: 'review', args: [] });
  assert.deepEqual(parseCommand('thanks!\n@Sentinel why no-eval-of-user-input'), { cmd: 'why', args: ['no-eval-of-user-input'] });
  assert.deepEqual(parseCommand('@aftergraph-sentinel help'), { cmd: 'help', args: [] });
  assert.deepEqual(parseCommand('@sentinel'), { cmd: 'help', args: [] });
  assert.equal(parseCommand('@sentinelbot review'), null);
  assert.equal(parseCommand('please ask @sentinel later'), null);
  assert.equal(parseCommand(undefined), null);
  assert.equal(parseCommand('@sentinel deploy').cmd, 'unknown');
});

test('authorize: only write-level humans, never bots', () => {
  assert.equal(authorize(payload('x')).ok, true);
  assert.equal(authorize(payload('x', { assoc: 'CONTRIBUTOR' })).ok, false);
  assert.equal(authorize(payload('x', { assoc: 'NONE' })).ok, false);
  assert.equal(authorize(payload('x', { type: 'Bot' })).reason, 'bot');
  assert.equal(authorize(payload('x', { login: 'aftergraph-sentinel[bot]' })).reason, 'bot');
});

test('@sentinel review re-reviews the exact current HEAD and refreshes the card', async () => {
  const p = platform(); const { d, o } = opts();
  try {
    const out = await routeEvent({ event: 'issue_comment', payload: payload('@sentinel review'), platform: p, opts: o });
    assert.equal(out.command, 'review');
    assert.equal(out.handled, true);
    assert.equal(out.verdict, 'SHIP');
    assert.ok(out.receipt);
    assert.equal(p.calls.filter((c) => c.op === 'post').length, 1);
    assert.match(p.calls[0].body, /sentinel-verdict/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('help / why / unknown reply once, marked, never review', async () => {
  for (const [body, re] of [['@sentinel help', /Sentinel commands/], ['@sentinel why ' + ruleIdsForPack()[0], /severity/], ['@sentinel why nope', /not a rule/], ['@sentinel merge', /Unknown command `merge`/]]) {
    const p = platform(); const { d, o } = opts();
    try {
      const out = await routeEvent({ event: 'issue_comment', payload: payload(body), platform: p, opts: o });
      assert.equal(out.handled, true);
      assert.equal(p.calls.length, 1);
      assert.ok(p.calls[0].body.startsWith(REPLY_MARKER));
      assert.match(p.calls[0].body, re);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }
});

test('untrusted, bot, non-PR, edited and plain comments are ignored without writes', async () => {
  const cases = [
    [payload('@sentinel review', { assoc: 'NONE' }), /association:NONE/],
    [payload('@sentinel review', { type: 'Bot' }), /bot/],
    [payload('@sentinel review', { pr: false }), /not-pr/],
    [payload('@sentinel review', { action: 'edited' }), /issue_comment:edited/],
    [payload('lgtm'), /no-command/],
  ];
  for (const [pl, re] of cases) {
    const p = platform(); const { d, o } = opts();
    try {
      const out = await routeEvent({ event: 'issue_comment', payload: pl, platform: p, opts: o });
      assert.equal(out.handled, false);
      assert.match(out.action, re);
      assert.equal(p.calls.length, 0);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }
});

test('help text never claims commands that do not exist', () => {
  const h = helpText();
  for (const m of h.matchAll(/`@sentinel (\w+)/g)) assert.ok(['review', 'why', 'help'].includes(m[1]));
  assert.match(whyText(), /Usage/);
});

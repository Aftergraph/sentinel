import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkFreshness } from '../lib/review.js';

test('fresh when head and base are unchanged', () => {
  const r = checkFreshness(
    { headSha: 'aaa', baseSha: 'bbb' },
    { headSha: 'aaa', baseSha: 'bbb' },
  );
  assert.equal(r.fresh, true);
});

test('stale when base moved', () => {
  const r = checkFreshness(
    { headSha: 'aaa', baseSha: 'bbb' },
    { headSha: 'aaa', baseSha: 'ccc' },
  );
  assert.equal(r.fresh, false);
  assert.match(r.reason, /base/);
});

test('stale when head moved', () => {
  const r = checkFreshness(
    { headSha: 'aaa', baseSha: 'bbb' },
    { headSha: 'ddd', baseSha: 'bbb' },
  );
  assert.equal(r.fresh, false);
  assert.match(r.reason, /head/);
});

test('stale when both moved', () => {
  const r = checkFreshness(
    { headSha: 'aaa', baseSha: 'bbb' },
    { headSha: 'ddd', baseSha: 'ccc' },
  );
  assert.equal(r.fresh, false);
});

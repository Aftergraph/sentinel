import test from 'node:test';
import assert from 'node:assert/strict';
import { isFreeRefund, formatAmount } from './refunds.js';

test('isFreeRefund treats zero amount as free', () => {
  assert.equal(isFreeRefund({ amount: 0 }), true);
  assert.equal(isFreeRefund({ amount: 100 }), false);
});

test('formatAmount renders dollars', () => {
  assert.equal(formatAmount(100), '$1.00');
  assert.equal(formatAmount(0), '$0.00');
});

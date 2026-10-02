// Webhook signature verification (HMAC-SHA256, GitHub x-hub-signature-256).
// Pure: (rawBodyBuffer, signatureHeader, secret) -> boolean.
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  // Constant-time comparison: pad to equal length so timing doesn't leak
  // whether the attacker's guess has the right length.
  const maxLen = Math.max(a.length, b.length);
  const aPadded = Buffer.alloc(maxLen, 0);
  const bPadded = Buffer.alloc(maxLen, 0);
  a.copy(aPadded);
  b.copy(bPadded);
  return a.length === b.length && timingSafeEqual(aPadded, bPadded);
}

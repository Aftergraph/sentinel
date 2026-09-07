// Webhook signature verification (HMAC-SHA256, GitHub x-hub-signature-256).
// Pure: (rawBodyBuffer, signatureHeader, secret) -> boolean.
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

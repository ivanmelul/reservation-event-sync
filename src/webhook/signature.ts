import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook authenticity, the way Stripe/Shopify/GitHub do it: the PMS signs the raw body with a
 * shared secret and sends `x-pms-signature: sha256=<hex>`. Anyone without the secret can't forge events.
 */
export const SIGNATURE_HEADER = 'x-pms-signature';

export function sign(rawBody: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function isValidSignature(rawBody: string, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const expected = Buffer.from(sign(rawBody, secret));
  const received = Buffer.from(header);
  // Constant-time compare so the signature can't be guessed byte by byte from response timings.
  return expected.length === received.length && timingSafeEqual(expected, received);
}

import { createHmac, timingSafeEqual } from 'node:crypto'

/** Verify GitHub's `X-Hub-Signature-256` HMAC over the exact raw request body. */
export function verifySignature(secret: string, body: Buffer, header: string | undefined) {
  if (!header?.startsWith('sha256=')) return false
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`)
  const received = Buffer.from(header)
  return expected.length === received.length && timingSafeEqual(expected, received)
}

export const ANALYZED_PULL_REQUEST_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review'])

import { randomUUID } from "node:crypto";

/**
 * Issue a nonce from the Node CSPRNG (`crypto.randomUUID`, UUID v4).
 * Never `Math.random`, never a counter — unguessable and unique under
 * concurrent issuance (WBS OIK-021).
 */
export function generateNonce(): string {
  return randomUUID();
}

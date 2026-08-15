import { actionDigest, type ActionDigestInput, type JsonValue } from "@oikonomos/shared";

export type { ActionDigestInput, JsonValue };

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Bind an action to its digest. Delegates entirely to `@oikonomos/shared`
 * (N10 / Handover §4.3) — this package must never reimplement canonical
 * JSON or sha256.
 */
export function bindActionDigest(action: ActionDigestInput): string {
  return actionDigest(action);
}

/** Convert the shared hex digest into the `bytea` payload `insertApproval` stores. */
export function actionDigestToBytes(hex: string): Uint8Array {
  if (!SHA256_HEX.test(hex)) {
    throw new Error("actionDigest must be a 64-char lowercase hex sha256.");
  }
  return Buffer.from(hex, "hex");
}

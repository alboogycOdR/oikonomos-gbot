/**
 * Action digest — the platform's single approval-binding hash (N10,
 * Handover §4.3): `action_digest = sha256(canonicalJson({toolName, input,
 * destination}))`. Node `crypto` only, zero runtime dependencies.
 */
import { createHash } from "node:crypto";
import { canonicalJson, type JsonValue } from "./canonicalJson.js";

/** The three fields bound into every action digest, per Handover §4.3. */
export interface ActionDigestInput {
  readonly toolName: string;
  readonly input: JsonValue;
  readonly destination: JsonValue;
}

/**
 * Compute the sha256 action digest for an approval binding. Deterministic:
 * the same `{toolName, input, destination}` value always yields the same
 * lowercase hex digest, in this process or any other. Propagates
 * {@link CanonicalJsonError} unchanged if the input cannot be canonicalized
 * (e.g. contains `undefined` or a non-finite number).
 */
export function actionDigest(action: ActionDigestInput): string {
  const canonical = canonicalJson({
    toolName: action.toolName,
    input: action.input,
    destination: action.destination,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

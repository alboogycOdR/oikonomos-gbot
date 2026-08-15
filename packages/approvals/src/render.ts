import { canonicalJson, type ActionDigestInput } from "@oikonomos/shared";

/**
 * Human-readable approval text derived from the same `{toolName, input,
 * destination}` object `actionDigest` hashes (ADR-004). Never accepts
 * caller-supplied prose — there is no render parameter on this function.
 *
 * Lives in this package because `packages/shared` is outside TASK-015
 * Owned_Paths. Canonicalization is still the single `@oikonomos/shared`
 * implementation (N10); this only formats those bytes.
 */
export function actionRender(action: ActionDigestInput): string {
  const bound = canonicalJson({
    toolName: action.toolName,
    input: action.input,
    destination: action.destination,
  });
  const destination =
    typeof action.destination === "string"
      ? action.destination
      : canonicalJson(action.destination);
  return [
    `destination: ${destination}`,
    `toolName: ${action.toolName}`,
    `input: ${canonicalJson(action.input)}`,
    `bound: ${bound}`,
  ].join("\n");
}

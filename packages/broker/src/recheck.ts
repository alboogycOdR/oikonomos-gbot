/**
 * Call-time re-check of the derived allowedTools / manifest map (TASK-066,
 * study §Tier 1.6).
 *
 * Grok Bot filters disabled MCP tools at enumeration AND re-checks the
 * disabled map inside `executeTool` before dispatch, because the model may
 * hold a stale tool list. Enumeration-time filtering is not enforcement.
 *
 * Layering (ADR-001): this re-check is additive to L1 `handlePreToolUse`.
 * It does not replace capability/tier/approval resolution. A miss here
 * denies with {@link ALLOWLIST_MISS_REASON}; a hit falls through to L1.
 * The map is the derived allowedTools/manifest surface — never a cached
 * live listing (TASK-068 must not feed this path).
 */

/** Stable deny reason for a call-time allowlist / manifest-map miss. */
export const ALLOWLIST_MISS_REASON = "allowlist.miss" as const;

export type ManifestMap =
  | ReadonlySet<string>
  | readonly string[]
  | ReadonlyMap<string, unknown>
  | Readonly<Record<string, unknown>>;

export type RecheckDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: typeof ALLOWLIST_MISS_REASON };

function manifestHas(map: ManifestMap, toolName: string): boolean {
  if (map instanceof Set) return map.has(toolName);
  if (map instanceof Map) return map.has(toolName);
  if (Array.isArray(map)) return map.includes(toolName);
  if (typeof map === "object" && map !== null) {
    return Object.hasOwn(map, toolName);
  }
  return false;
}

/**
 * Re-validate `toolName` against the current derived allowedTools/manifest
 * map. A tool that appears only on a stale mounted list is denied.
 */
export function recheckAgainstManifest(
  toolName: string,
  manifestMap: ManifestMap,
): RecheckDecision {
  if (typeof toolName !== "string" || toolName.length === 0) {
    return { decision: "deny", reason: ALLOWLIST_MISS_REASON };
  }
  if (!manifestHas(manifestMap, toolName)) {
    return { decision: "deny", reason: ALLOWLIST_MISS_REASON };
  }
  return { decision: "allow" };
}

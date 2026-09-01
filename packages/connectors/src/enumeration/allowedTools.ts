import type { ConnectorManifest } from "../manifest/schema.js";
import type { EnumerationReport } from "./types.js";
import { containsWildcard, isFullyQualifiedMcpName } from "./mcpNames.js";

export type AllowedToolsErrorCode = "BARE_NAME" | "WILDCARD" | "NOT_QUALIFIED";

export class AllowedToolsError extends Error {
  readonly code: AllowedToolsErrorCode;
  readonly entry: string;

  constructor(message: string, code: AllowedToolsErrorCode, entry: string) {
    super(message);
    this.name = "AllowedToolsError";
    this.code = code;
    this.entry = entry;
  }
}

/**
 * Derive the L2 `allowedTools` surface from a mapped enumeration report.
 *
 * Layering (ADR-001): this allowlist is **defence in depth, not the
 * enforcement point**. L1 PreToolUse still decides every call. A tool
 * omitted here must ALSO be denied by L1 if it is invoked (Handover §4.2
 * unregistered ⇒ deny; CAN-02: a bare-name allow-rule must not bypass L1).
 *
 * Construction rules:
 * - fully-qualified `mcp__<server>__<tool>` names only
 * - unmapped tools never appear (they are not in `report.mapped`)
 * - `enabled: false` capabilities (e.g. `email.send`) never appear — that
 *   is how Gmail send stays unreachable while G-CONN is closed
 * - bare names and wildcards throw rather than leak onto the surface
 */
export function allowedToolsFor(
  manifest: ConnectorManifest,
  report: EnumerationReport,
): readonly string[] {
  const byToolName = new Map<string, ConnectorManifest["tools"][number]>();
  for (const tool of manifest.tools) {
    byToolName.set(tool.tool_name, tool);
  }

  const allowlist: string[] = [];
  for (const mapped of report.mapped) {
    const entry = byToolName.get(mapped.toolName);
    if (entry === undefined) {
      continue;
    }
    // MUTATION target: enabled === false MUST be omitted.
    // Removing this continue lets email.send into the allowlist and turns
    // the MUTATION-PROVEN test red.
    if (entry.enabled === false) {
      continue;
    }
    assertFullyQualifiedMcpName(mapped.toolName);
    allowlist.push(mapped.toolName);
  }

  allowlist.sort((a, b) => a.localeCompare(b));
  return Object.freeze([...allowlist]);
}

function assertFullyQualifiedMcpName(name: string): void {
  if (containsWildcard(name)) {
    throw new AllowedToolsError(
      `wildcard allowedTools entry rejected: ${name}`,
      "WILDCARD",
      name,
    );
  }
  if (name.includes("(") || name.includes(")") || !name.startsWith("mcp__")) {
    throw new AllowedToolsError(
      `bare-name allowedTools entry rejected: ${name}`,
      "BARE_NAME",
      name,
    );
  }
  if (!isFullyQualifiedMcpName(name)) {
    throw new AllowedToolsError(
      `not a fully-qualified mcp__<server>__<tool> name: ${name}`,
      "NOT_QUALIFIED",
      name,
    );
  }
}

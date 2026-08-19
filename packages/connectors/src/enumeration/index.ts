import type { ConnectorManifest } from "../manifest/schema.js";
import { riskTiers } from "../manifest/schema.js";

export const UNOBSERVABLE_ZERO_TOOLS = "UNOBSERVABLE: zero tools enumerated";

/** Injected MCP surface — tests supply a fake; no live MCP in this package. */
export interface ToolEnumerator {
  listTools(): Promise<readonly string[]>;
}

export interface MappedTool {
  readonly toolName: string;
  readonly capabilityId: string;
  readonly defaultTier: (typeof riskTiers)[number];
}

export interface StaleTool {
  readonly toolName: string;
  readonly capabilityId: string;
  readonly defaultTier: (typeof riskTiers)[number];
}

/**
 * Persistable OIK-049 report. `ok` is false when any exposed tool is unmapped
 * or the enumeration is unobservable. Stale manifest entries are warnings only.
 */
export interface EnumerationReport {
  readonly ok: boolean;
  readonly connectorId: string;
  readonly generatedAt: string;
  readonly mapped: readonly MappedTool[];
  readonly unmapped: readonly string[];
  readonly stale: readonly StaleTool[];
  readonly warnings: readonly string[];
  readonly unobservable?: "zero_tools";
  readonly message: string;
}

export interface EnumerateToolsOptions {
  readonly now?: () => Date;
}

function compareName(a: string, b: string): number {
  return a.localeCompare(b);
}

function staleWarning(tool: StaleTool): string {
  return `stale mapping: ${tool.toolName} (${tool.capabilityId}) is no longer exposed`;
}

/**
 * Compare the tools an MCP server actually exposes against the manifest map.
 * Unmapped exposed tools fail the check (WBS OIK-049). Empty `listTools()`
 * fails as unobservable (ADR-005) rather than passing vacuously.
 */
export async function enumerateTools(
  manifest: ConnectorManifest,
  enumerator: ToolEnumerator,
  options: EnumerateToolsOptions = {},
): Promise<EnumerationReport> {
  const clock = options.now ?? (() => new Date());
  const generatedAt = clock().toISOString();
  const connectorId = manifest.connector_id;

  let exposedRaw: readonly string[];
  try {
    exposedRaw = await enumerator.listTools();
  } catch (error) {
    const detail = error instanceof Error ? error.message : "listTools failed";
    return {
      ok: false,
      connectorId,
      generatedAt,
      mapped: [],
      unmapped: [],
      stale: [],
      warnings: [],
      message: `listTools failed: ${detail}`,
    };
  }

  if (exposedRaw.some((name) => name.trim().length === 0)) {
    return {
      ok: false,
      connectorId,
      generatedAt,
      mapped: [],
      unmapped: [],
      stale: [],
      warnings: [],
      message: "listTools returned an empty tool name",
    };
  }

  if (exposedRaw.length === 0) {
    return {
      ok: false,
      connectorId,
      generatedAt,
      mapped: [],
      unmapped: [],
      stale: [],
      warnings: [],
      unobservable: "zero_tools",
      message: `${UNOBSERVABLE_ZERO_TOOLS} for ${connectorId}`,
    };
  }

  const byToolName = new Map<string, ConnectorManifest["tools"][number]>();
  for (const tool of manifest.tools) {
    if (byToolName.has(tool.tool_name)) {
      return {
        ok: false,
        connectorId,
        generatedAt,
        mapped: [],
        unmapped: [],
        stale: [],
        warnings: [],
        message: `duplicate tool_name in manifest: ${tool.tool_name}`,
      };
    }
    byToolName.set(tool.tool_name, tool);
  }

  const exposed = [...new Set(exposedRaw)];
  const mapped: MappedTool[] = [];
  const unmapped: string[] = [];

  for (const toolName of exposed) {
    const entry = byToolName.get(toolName);
    if (entry === undefined) {
      unmapped.push(toolName);
      continue;
    }
    mapped.push({
      toolName,
      capabilityId: entry.capability_id,
      defaultTier: entry.default_tier,
    });
  }

  mapped.sort((a, b) => compareName(a.toolName, b.toolName));
  unmapped.sort(compareName);

  const exposedSet = new Set(exposed);
  const stale: StaleTool[] = [];
  for (const tool of manifest.tools) {
    if (!exposedSet.has(tool.tool_name)) {
      stale.push({
        toolName: tool.tool_name,
        capabilityId: tool.capability_id,
        defaultTier: tool.default_tier,
      });
    }
  }
  stale.sort((a, b) => compareName(a.toolName, b.toolName));
  const warnings = stale.map(staleWarning);

  // MUTATION target: unmapped must fail. `ok = true` here turns the unmapped tests red.
  const ok = unmapped.length === 0;
  const message = ok
    ? stale.length > 0
      ? `mapped ${mapped.length} tool(s); ${stale.length} stale warning(s)`
      : `mapped ${mapped.length} tool(s)`
    : `unmapped tools: ${unmapped.join(", ")}`;

  return {
    ok,
    connectorId,
    generatedAt,
    mapped,
    unmapped,
    stale,
    warnings,
    message,
  };
}

/** Stable JSON for the OIK-050 onboarding record. */
export function serializeEnumerationReport(report: EnumerationReport): string {
  return `${JSON.stringify(report)}\n`;
}

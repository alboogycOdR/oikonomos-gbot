import type { ConnectorManifest } from "../manifest/schema.js";

type RiskTier = ConnectorManifest["tools"][number]["default_tier"];

/** Injected MCP surface. Tests supply a fake; production uses the HTTP adapter. */
export interface ToolEnumerator {
  listTools(): Promise<readonly string[]>;
}

export interface MappedTool {
  readonly toolName: string;
  readonly capabilityId: string;
  readonly defaultTier: RiskTier;
}

export interface StaleTool {
  readonly toolName: string;
  readonly capabilityId: string;
  readonly defaultTier: RiskTier;
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

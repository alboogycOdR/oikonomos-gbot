/**
 * L2 outer-shell validator (OIK-036 / ADR-001 L2, R1, F2).
 *
 * Builds the `dontAsk` + explicit `allowedTools` policy that createHarness
 * injects as the L2 port. Bare-name entries auto-approve every call to that
 * tool (F2) and are rejected unless an ADR amendment names the tool.
 *
 * L1 still denies regardless; this is defence in depth, not enforcement.
 */

import {
  isL2Policy,
  L2_PERMISSION_MODE,
  type AllowedTool,
  type L2Policy,
} from "../config.js";

/** ADR-001 CAN-02 / directive §6 — the config-layer half of the canary. */
export const CAN02_TIER3_BARE_NAME = "mcp__gmail__send_message";

export type L2ConfigErrorCode =
  | "INVALID_L2"
  | "WRONG_PERMISSION_MODE"
  | "BARE_NAME"
  | "INVALID_ENTRY";

export class L2ConfigError extends Error {
  readonly code: L2ConfigErrorCode;
  readonly entry: string | undefined;

  constructor(message: string, code: L2ConfigErrorCode, entry?: string) {
    super(message);
    this.name = "L2ConfigError";
    this.code = code;
    this.entry = entry;
  }
}

/**
 * ADR-001 R1 exception list. Empty until an amendment names a tool and
 * justification. Never populate from a comment or a local override.
 */
export interface AdrNamedBareTool {
  readonly adr: string;
  readonly justification: string;
}

export type AdrNamedBareToolRegistry = Readonly<Record<string, AdrNamedBareTool>>;

export const ADR_NAMED_BARE_TOOLS: AdrNamedBareToolRegistry = Object.freeze({});

export type AllowedToolKind = "scoped" | "bare";

export type ClassifiedAllowedTool =
  | { kind: "scoped"; name: string; spec: string; entry: string }
  | { kind: "bare"; name: string; entry: string };

export interface ValidateL2PolicyOptions {
  /** Test/composition override. Production callers omit this. */
  readonly adrNamedBareTools?: AdrNamedBareToolRegistry;
}

const TOOL_NAME = /^[^\s()]+$/;

export function createL2Policy(
  allowedTools: readonly string[],
  options?: ValidateL2PolicyOptions,
): L2Policy {
  return validateL2Policy(
    { permissionMode: L2_PERMISSION_MODE, allowedTools },
    options,
  );
}

export function validateL2Policy(
  value: unknown,
  options?: ValidateL2PolicyOptions,
): L2Policy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new L2ConfigError(
      "L2 policy must be an object with permissionMode and allowedTools",
      "INVALID_L2",
    );
  }

  const record = value as { permissionMode?: unknown; allowedTools?: unknown };
  if (record.permissionMode !== L2_PERMISSION_MODE) {
    throw new L2ConfigError(
      `L2 permissionMode must be "${L2_PERMISSION_MODE}"; unlisted tools are hard-denied, not callback-reliant`,
      "WRONG_PERMISSION_MODE",
    );
  }
  if (!Array.isArray(record.allowedTools)) {
    throw new L2ConfigError("L2 allowedTools must be an explicit array", "INVALID_L2");
  }

  const named = options?.adrNamedBareTools ?? ADR_NAMED_BARE_TOOLS;
  const validated: AllowedTool[] = record.allowedTools.map((entry) =>
    validateAllowedTool(entry, named),
  );

  const policy: L2Policy = Object.freeze({
    permissionMode: L2_PERMISSION_MODE,
    allowedTools: Object.freeze([...validated]),
  });

  if (!isL2Policy(policy)) {
    throw new L2ConfigError("validated L2 policy failed the config.ts type guard", "INVALID_L2");
  }
  return policy;
}

export function validateAllowedTool(
  entry: unknown,
  adrNamedBareTools: AdrNamedBareToolRegistry = ADR_NAMED_BARE_TOOLS,
): AllowedTool {
  if (typeof entry !== "string") {
    throw new L2ConfigError("allowedTools entries must be strings", "INVALID_ENTRY");
  }

  const classified = classifyAllowedTool(entry);
  if (classified.kind === "scoped") {
    return classified.entry;
  }

  const amendment = adrNamedBareTools[classified.name];
  if (!isAdrNamedBareTool(amendment)) {
    throw new L2ConfigError(
      `bare-name allowedTools entry "${classified.entry}" is rejected (ADR-001 R1/F2); use scoped form Tool(spec) or an ADR amendment that names the tool`,
      "BARE_NAME",
      classified.entry,
    );
  }
  return classified.entry;
}

export function classifyAllowedTool(entry: string): ClassifiedAllowedTool {
  const trimmed = entry.trim();
  if (trimmed.length === 0) {
    throw new L2ConfigError("allowedTools entry is empty", "INVALID_ENTRY", entry);
  }

  const open = trimmed.indexOf("(");
  if (open === -1) {
    if (!TOOL_NAME.test(trimmed)) {
      throw new L2ConfigError(
        `allowedTools entry "${trimmed}" is not a valid tool name`,
        "INVALID_ENTRY",
        entry,
      );
    }
    return { kind: "bare", name: trimmed, entry: trimmed };
  }

  if (!trimmed.endsWith(")")) {
    throw new L2ConfigError(
      `allowedTools entry "${trimmed}" is not scoped form Tool(spec)`,
      "INVALID_ENTRY",
      entry,
    );
  }

  const name = trimmed.slice(0, open);
  const spec = trimmed.slice(open + 1, -1);
  if (!TOOL_NAME.test(name) || spec.trim().length === 0) {
    throw new L2ConfigError(
      `allowedTools entry "${trimmed}" is not scoped form Tool(spec)`,
      "INVALID_ENTRY",
      entry,
    );
  }
  return { kind: "scoped", name, spec, entry: trimmed };
}

export function isScopedAllowedTool(entry: string): boolean {
  try {
    return classifyAllowedTool(entry).kind === "scoped";
  } catch {
    return false;
  }
}

export function isBareNameAllowedTool(entry: string): boolean {
  try {
    return classifyAllowedTool(entry).kind === "bare";
  } catch {
    return false;
  }
}

function isAdrNamedBareTool(value: AdrNamedBareTool | undefined): value is AdrNamedBareTool {
  return (
    value !== undefined &&
    typeof value.adr === "string" &&
    value.adr.trim().length > 0 &&
    typeof value.justification === "string" &&
    value.justification.trim().length > 0
  );
}

/** Tool names present on the validated allowlist (scoped prefix or ADR-named bare). */
export function explicitSurfaceToolNames(policy: L2Policy): readonly string[] {
  const names = new Set<string>();
  for (const entry of policy.allowedTools) {
    names.add(classifyAllowedTool(entry).name);
  }
  return [...names];
}

/**
 * True only if `toolName` appears on the explicit L2 surface.
 * Unlisted names are hard-denied by `dontAsk` (ADR-001 L2 / F3).
 */
export function isListedOnL2Surface(policy: L2Policy, toolName: string): boolean {
  return explicitSurfaceToolNames(policy).includes(toolName);
}

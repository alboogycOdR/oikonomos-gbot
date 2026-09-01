/**
 * Fully-qualified MCP tool names as ADR-001 L2 / TASK-054 require them:
 * `mcp__<server>__<tool>` — never a bare tool name, never a wildcard, never
 * scoped `Tool(spec)` form. The Agent SDK qualifies MCP tools this way;
 * the live server typically exposes the bare `<tool>` segment only.
 */

const SERVER_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const TOOL_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const QUALIFIED = /^mcp__([A-Za-z0-9][A-Za-z0-9_-]*)__([A-Za-z0-9][A-Za-z0-9_.-]*)$/;

export function isValidMcpServerName(name: string): boolean {
  return SERVER_SEGMENT.test(name);
}

export function containsWildcard(name: string): boolean {
  return name.includes("*") || name.includes("?");
}

export function isFullyQualifiedMcpName(name: string): boolean {
  if (name !== name.trim()) {
    return false;
  }
  if (containsWildcard(name) || name.includes("(") || name.includes(")")) {
    return false;
  }
  return QUALIFIED.test(name);
}

/**
 * Qualify a `tools/list` name against the mounted server. Already-qualified
 * names pass through (so a fake enumerator that returns `mcp__gmail__…`
 * keeps working). Bare names become `mcp__<server>__<tool>`.
 */
export function qualifyMcpToolName(serverName: string, exposedName: string): string {
  const trimmed = exposedName.trim();
  if (trimmed.startsWith("mcp__")) {
    return trimmed;
  }
  return `mcp__${serverName}__${trimmed}`;
}

export function assertValidServerName(serverName: string): void {
  if (!isValidMcpServerName(serverName)) {
    throw new Error("mcp server name is invalid");
  }
}

export function assertToolSegment(name: string): void {
  if (!TOOL_SEGMENT.test(name) || containsWildcard(name)) {
    throw new Error("listTools failed: invalid tool name");
  }
}

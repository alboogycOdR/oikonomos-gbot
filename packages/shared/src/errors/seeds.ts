/**
 * Seed registrations for error families that already exist in the codebase
 * (TASK-069 description: "survey broker/approvals/harness-factory/audit
 * test failures for names — read-only survey; do not modify other
 * packages"). Adoption by the surveyed packages — i.e. having their catch
 * blocks actually construct these instead of ad-hoc `new Error(...)` — is
 * explicitly NOT this task; these seeds only give the closed taxonomy a
 * starting vocabulary that matches names already in use, generated through
 * {@link defineRegisteredError} like any other entry.
 *
 * Survey sources (read-only, no other package touched):
 *  - packages/broker/src/index.ts: `BrokerFailure`, `AuditUnavailableError`
 *  - packages/harness-factory/src/index.ts: `HarnessFactoryError`
 *  - packages/harness-factory/src/l2/allowed-tools.ts: `L2ConfigError`
 *    codes INVALID_L2 / WRONG_PERMISSION_MODE / BARE_NAME / INVALID_ENTRY
 *  - packages/harness-factory/src/mcp/config.ts: `McpConfigError` codes
 *    INVALID_MCP_SERVERS / INVALID_SERVER_NAME / INVALID_TRANSPORT /
 *    INVALID_STDIO / INVALID_HTTP / INVALID_ARGS / INVALID_HEADERS
 *  - packages/harness-factory/src/subagent.ts: `SubagentPolicyError` codes
 *    INVALID_SUBAGENT / BANNED_MODE
 *  - packages/audit/src/index.ts: `AuditWriteError`
 */

import { defineRegisteredError } from "./registry.js";

/** packages/broker: broker call failed (network/HTTP/timeout/malformed response — ADR-001 R3 fail-closed). */
export const mintBrokerFailure = defineRegisteredError({
  code: "BROKER_FAILURE",
  domain: "broker",
  retryable: false,
  summary: "Broker call failed; ADR-001 R3 requires the caller to fail closed.",
  payload: ["reason", "toolName"] as const,
});

/** packages/broker: the broker's audit sink was unreachable or errored while recording a decision. */
export const mintAuditUnavailable = defineRegisteredError({
  code: "AUDIT_UNAVAILABLE",
  domain: "broker",
  retryable: false,
  summary: "Broker audit sink unavailable; decision could not be durably recorded.",
  payload: ["reason"] as const,
});

/** packages/harness-factory: generic harness assembly/config failure not covered by a narrower code below. */
export const mintHarnessFactoryError = defineRegisteredError({
  code: "HARNESS_FACTORY",
  domain: "harness-factory",
  retryable: false,
  summary: "Harness assembly failed.",
  payload: ["reason"] as const,
});

/** packages/harness-factory L2: outer-shell allowed-tools policy failed validation. */
export const mintL2ConfigError = defineRegisteredError({
  code: "L2_CONFIG_INVALID",
  domain: "harness-factory",
  retryable: false,
  summary: "L2 allowed-tools policy failed validation.",
  payload: ["l2Code", "entry"] as const,
});

/** packages/harness-factory mcp: injected MCP server configuration failed validation. */
export const mintMcpConfigError = defineRegisteredError({
  code: "MCP_CONFIG_INVALID",
  domain: "harness-factory",
  retryable: false,
  summary: "MCP server configuration failed validation.",
  payload: ["mcpCode", "serverName"] as const,
});

/** packages/harness-factory subagent: a subagent definition was invalid or requested a banned permission mode. */
export const mintSubagentPolicyError = defineRegisteredError({
  code: "SUBAGENT_POLICY",
  domain: "harness-factory",
  retryable: false,
  summary: "Subagent definition violates platform policy.",
  payload: ["subagentCode", "subagentName"] as const,
});

/** packages/audit: a write to audit_events failed; callers MUST treat this as "not audited" and fail closed. */
export const mintAuditWriteError = defineRegisteredError({
  code: "AUDIT_WRITE_FAILED",
  domain: "audit",
  retryable: false,
  summary: "Audit event write failed; treat as not-audited and fail closed.",
  payload: ["actor", "eventType"] as const,
});

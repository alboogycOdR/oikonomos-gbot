import type { McpServers } from "../mcp/types.js";

/**
 * Opaque handle returned to a caller (ultimately the model, via
 * `services/worker`). Carries no secret material — never a token, url,
 * header, or credential (F10 / probe Q11: "the model gets an opaque
 * server-side session plus whatever identity metadata a tool chooses to
 * return, never the token").
 */
export interface ConnectorSessionHandle {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly connectorId: string;
  /** Already-resolved MCP server config for this session's connector. */
  readonly mcpServers: McpServers;
}

export interface MintConnectorSessionInput {
  readonly tenantId: string;
  readonly connectorId: string;
}

/**
 * Mints a fresh session's MCP server config for a (tenant, connector) pair.
 * The pool calls this on first use and again on transparent re-mint after
 * expiry; it never caches secret values itself (N4/N9) — the minter (or
 * whatever it wraps, e.g. `mcpConfigFromManifest`) owns resolution.
 */
export type ConnectorSessionMinter = (
  input: MintConnectorSessionInput,
) => Promise<McpServers> | McpServers;

export interface ConnectorSessionPoolOptions {
  readonly mint: ConnectorSessionMinter;
  /** Session lifetime before transparent re-mint. Defaults to 1 hour. */
  readonly ttlMs?: number;
  readonly now?: () => Date;
  /** Session id generator; defaults to a random opaque id. */
  readonly generateSessionId?: () => string;
}

export type ConnectorSessionPoolErrorCode = "MINT_FAILED" | "INVALID_INPUT" | "UNKNOWN_SESSION";

export class ConnectorSessionPoolError extends Error {
  readonly code: ConnectorSessionPoolErrorCode;

  constructor(message: string, code: ConnectorSessionPoolErrorCode) {
    super(message);
    this.name = "ConnectorSessionPoolError";
    this.code = code;
  }
}

/**
 * Tenant-scoped, durable-across-runs session pool (F10 / ADR-010 §4,
 * "signed in once, available thereafter"). `acquire` mints on first use and
 * reuses thereafter, transparently re-minting an expired session; `release`
 * returns the handle to the pool rather than tearing anything down.
 *
 * Scoped by tenant + connector only, never by role: roles share sessions by
 * design (a role is not a security boundary — §6.2 / F10).
 */
export interface ConnectorSessionPool {
  acquire(tenantId: string, connectorId: string): Promise<ConnectorSessionHandle>;
  release(handle: ConnectorSessionHandle): void;
  /** Diagnostic only: number of distinct (tenant, connector) sessions held live. Never exposes secret material. */
  readonly size: number;
}

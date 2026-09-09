import { fileURLToPath } from "node:url";
import type { ConnectorManifest, ConnectorSessionPool } from "@oikonomos/connectors";
import type { Database } from "@oikonomos/db";
import type { ConnectorContext } from "./executeRun.js";

/** The Gmail minter requires a URL resolver; keep the secret value out of errors. */
export async function resolveGmailMcpUrl(ref: string): Promise<string> {
  if (ref !== "secret://mcp/gmail/url") throw new Error(`unsupported connector URL secret ref: ${ref}`);
  const value = process.env.OIK_SECRET_MCP_GMAIL_URL;
  if (value === undefined || value.length === 0) throw new Error(`secret ref is unset: ${ref}`);
  return value;
}

export const WORKSPACE_SEND_TO_ROLE_CAPABILITY_ID = "workspace.send_to_role";
export const WORKSPACE_SEND_TO_ROLE_TOOL = "mcp__workspace__send_to_role";
export const WORKSPACE_RENAME_SELF_CAPABILITY_ID = "workspace.rename_self";
export const WORKSPACE_RENAME_SELF_TOOL = "mcp__workspace__rename_self";
export const WORKSPACE_REQUEST_SECRET_CAPABILITY_ID = "workspace.request_secret";
export const WORKSPACE_REQUEST_SECRET_TOOL = "mcp__workspace__request_secret";
export const WORKSPACE_CREATE_ROUTINE_CAPABILITY_ID = "workspace.create_routine";
export const WORKSPACE_CREATE_ROUTINE_TOOL = "mcp__workspace__create_routine";

/** Mount the internal stdio bridge only when its persisted role grant exists. */
export async function resolveGrantedWorkspaceConnector(input: {
  readonly database: Database;
  readonly connectionString: string;
  readonly roleId: string;
  readonly tenantId: string;
  readonly runId: string;
  /** Threaded through to create_routine's confirmation-message insert. */
  readonly threadId?: string;
}): Promise<ConnectorContext | undefined> {
  const grants = await input.database.listRoleGrants(input.roleId);
  const grantedCapabilities = new Set(grants.map((grant) => grant.capabilityId));
  const allowedTools = [
    ...(grantedCapabilities.has(WORKSPACE_SEND_TO_ROLE_CAPABILITY_ID) ? [WORKSPACE_SEND_TO_ROLE_TOOL] : []),
    ...(grantedCapabilities.has(WORKSPACE_RENAME_SELF_CAPABILITY_ID) ? [WORKSPACE_RENAME_SELF_TOOL] : []),
    ...(grantedCapabilities.has(WORKSPACE_REQUEST_SECRET_CAPABILITY_ID) ? [WORKSPACE_REQUEST_SECRET_TOOL] : []),
    ...(grantedCapabilities.has(WORKSPACE_CREATE_ROUTINE_CAPABILITY_ID) ? [WORKSPACE_CREATE_ROUTINE_TOOL] : []),
  ];
  if (allowedTools.length === 0) return undefined;
  return {
    manifest: { connector_id: "workspace", mcp_server: { name: "workspace" }, tools: [] },
    mcpServers: {
      workspace: {
        transport: "stdio",
        command: process.execPath,
        args: [
          fileURLToPath(new URL("./workspaceMcpServer.js", import.meta.url)),
          input.connectionString, input.tenantId, input.roleId, input.runId,
          ...(input.threadId === undefined ? [] : [input.threadId]),
        ],
      },
    },
    allowedTools,
  };
}

/** executeTaskRun accepts one context; merge independently grant-derived MCP mounts into it. */
export function combineConnectorContexts(
  ...contexts: readonly (ConnectorContext | undefined)[]
): ConnectorContext | undefined {
  const definedContexts = contexts.filter((context): context is ConnectorContext => context !== undefined);
  const [first] = definedContexts;
  if (first === undefined) return undefined;
  return {
    manifest: first.manifest,
    connectorIds: Object.freeze([...new Set(definedContexts.flatMap((context) => context.connectorIds ?? [context.manifest.connector_id]))]),
    mcpServers: Object.assign({}, ...definedContexts.map((context) => context.mcpServers)),
    allowedTools: definedContexts.flatMap((context) => context.allowedTools),
  };
}

export interface AcquiredConnector {
  readonly connector: ConnectorContext;
  readonly pool: ConnectorSessionPool;
  readonly handle: Awaited<ReturnType<ConnectorSessionPool["acquire"]>>;
}

/**
 * Derive the connector surface from persisted grants, not from a model prompt
 * or a manifest default. Every manifest connector is independently filtered
 * to its persisted grants before its session is ever acquired.
 */
export async function resolveGrantedGmailConnector(input: {
  readonly database: Database;
  readonly manifests: readonly ConnectorManifest[];
  readonly roleId: string;
  readonly tenantId: string;
  readonly gmailPoolFor: (manifest: ConnectorManifest) => ConnectorSessionPool;
}): Promise<AcquiredConnector | undefined> {
  return resolveGrantedManifestConnector({ ...input, connectorId: "gmail", poolFor: input.gmailPoolFor });
}

/** Mount Calendar only when at least one enabled Calendar tool is role-granted. */
export async function resolveGrantedGoogleCalendarConnector(input: {
  readonly database: Database;
  readonly manifests: readonly ConnectorManifest[];
  readonly roleId: string;
  readonly tenantId: string;
  readonly calendarPoolFor: (manifest: ConnectorManifest) => ConnectorSessionPool;
}): Promise<AcquiredConnector | undefined> {
  return resolveGrantedManifestConnector({ ...input, connectorId: "google-calendar", poolFor: input.calendarPoolFor });
}

/** Mount Drive only when at least one enabled Drive tool is role-granted. */
export async function resolveGrantedGoogleDriveConnector(input: {
  readonly database: Database;
  readonly manifests: readonly ConnectorManifest[];
  readonly roleId: string;
  readonly tenantId: string;
  readonly drivePoolFor: (manifest: ConnectorManifest) => ConnectorSessionPool;
}): Promise<AcquiredConnector | undefined> {
  return resolveGrantedManifestConnector({ ...input, connectorId: "google-drive", poolFor: input.drivePoolFor });
}

async function resolveGrantedManifestConnector(input: {
  readonly connectorId: string;
  readonly database: Database;
  readonly manifests: readonly ConnectorManifest[];
  readonly roleId: string;
  readonly tenantId: string;
  readonly poolFor: (manifest: ConnectorManifest) => ConnectorSessionPool;
}): Promise<AcquiredConnector | undefined> {
  const manifest = input.manifests.find((candidate) => candidate.connector_id === input.connectorId);
  if (manifest === undefined) return undefined;

  const grantedCapabilities = new Set((await input.database.listRoleGrants(input.roleId)).map((grant) => grant.capabilityId));
  const allowedTools = manifest.tools
    .filter((tool) => tool.enabled !== false && grantedCapabilities.has(tool.capability_id))
    .map((tool) => tool.tool_name);
  if (allowedTools.length === 0) return undefined;

  const pool = input.poolFor(manifest);
  const handle = await pool.acquire(input.tenantId, manifest.connector_id);
  return {
    pool,
    handle,
    connector: { manifest, mcpServers: handle.mcpServers, allowedTools },
  };
}

export const STEEL_BROWSER_CONNECTOR_ID = "steel-browser";

/**
 * Steel's local, in-sandbox MCP entrypoint (TASK-186's own constant in
 * packages/connectors/src/steelSession.ts). Duplicated here — not
 * imported — because neither @oikonomos/connectors ("." only) nor
 * @oikonomos/harness-factory (".", "./compose", "./mcp" only) re-export
 * steelSession.ts/browserLane.ts from their public package surface, and
 * widening either package's export map is outside this task's Owned_Paths.
 * Same duplication precedent as chatRunDriver.ts's own SANDBOX_IMAGE
 * literal for oikonomos-office-base.
 */
const STEEL_MCP_ENTRYPOINT = "/opt/oikonomos/steel-mcp/dist/stdio.js";

/**
 * Steel runs LOCAL, inside the same sandbox container the role's Claude CLI
 * runs in (unlike Gmail/Calendar/Drive's remote, OAuth-backed sessions) — a
 * real open design question TASK-186 raised but explicitly left
 * unresolved. Investigated here: there is no durable, cross-request session
 * to check out/return (no remote credential, no rate-limited backend to
 * pool), so `resolveGrantedManifestConnector`'s `pool.acquire()`/`release()`
 * shape does not fit — a stdio MCP server config is a pure, synchronous
 * function of the role's grants, closer to `chatRunDriver.ts`'s own
 * `resolveRoleSandbox` image-selection pattern than to a pooled connector.
 * No `ConnectorSessionPool` is constructed or required for this connector.
 *
 * `McpStdioServerConfig` (packages/harness-factory/src/mcp/types.ts) carries
 * no `env` field, so the `STEEL_LOCAL`/`STEEL_BASE_URL`/`STEEL_PROFILE`
 * environment steelSession.ts's own `SteelMcpServerConfig` documents cannot
 * be threaded through this mount — widening that type is outside this
 * task's Owned_Paths (packages/harness-factory/src/mcp/**). The mounted
 * stdio command relies on the MCP server's own defaults, which match the
 * office-browser image's entrypoint (`infra/sandbox/images/office-browser/
 * browser-entrypoint.sh` hardcodes `HOST=127.0.0.1 PORT=3000`, the same
 * loopback default steelSession.ts documents) — a disclosed, real gap, not
 * a silent one.
 */
export async function resolveGrantedBrowserConnector(input: {
  readonly database: Database;
  readonly manifests: readonly ConnectorManifest[];
  readonly roleId: string;
}): Promise<ConnectorContext | undefined> {
  const manifest = input.manifests.find((candidate) => candidate.connector_id === STEEL_BROWSER_CONNECTOR_ID);
  if (manifest === undefined) return undefined;

  const grantedCapabilities = new Set((await input.database.listRoleGrants(input.roleId)).map((grant) => grant.capabilityId));
  const allowedTools = grantedManifestToolNames(manifest, grantedCapabilities);
  if (allowedTools.length === 0) return undefined;

  return {
    manifest,
    mcpServers: {
      steel: {
        transport: "stdio",
        command: "node",
        args: [STEEL_MCP_ENTRYPOINT],
      },
    },
    allowedTools,
  };
}

/**
 * Pure grant check shared with `resolveGrantedBrowserConnector` — used by
 * `chatRunDriver.ts`'s `resolveRoleSandbox` to pick the `office-browser`
 * image without a second Postgres round trip (it already holds the same
 * role's `grants` from its own `database.listRoleGrants` call).
 */
export function isBrowserLaneGranted(
  manifests: readonly ConnectorManifest[],
  grantedCapabilityIds: ReadonlySet<string>,
): boolean {
  const manifest = manifests.find((candidate) => candidate.connector_id === STEEL_BROWSER_CONNECTOR_ID);
  if (manifest === undefined) return false;
  return grantedManifestToolNames(manifest, grantedCapabilityIds).length > 0;
}

function grantedManifestToolNames(manifest: ConnectorManifest, grantedCapabilityIds: ReadonlySet<string>): string[] {
  return manifest.tools
    .filter((tool) => tool.enabled !== false && grantedCapabilityIds.has(tool.capability_id))
    .map((tool) => tool.tool_name);
}

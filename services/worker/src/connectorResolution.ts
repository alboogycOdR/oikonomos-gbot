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

/** Mount the internal stdio bridge only when its persisted role grant exists. */
export async function resolveGrantedWorkspaceConnector(input: {
  readonly database: Database;
  readonly connectionString: string;
  readonly roleId: string;
  readonly tenantId: string;
  readonly runId: string;
}): Promise<ConnectorContext | undefined> {
  const grants = await input.database.listRoleGrants(input.roleId);
  const grantedCapabilities = new Set(grants.map((grant) => grant.capabilityId));
  const allowedTools = [
    ...(grantedCapabilities.has(WORKSPACE_SEND_TO_ROLE_CAPABILITY_ID) ? [WORKSPACE_SEND_TO_ROLE_TOOL] : []),
    ...(grantedCapabilities.has(WORKSPACE_RENAME_SELF_CAPABILITY_ID) ? [WORKSPACE_RENAME_SELF_TOOL] : []),
    ...(grantedCapabilities.has(WORKSPACE_REQUEST_SECRET_CAPABILITY_ID) ? [WORKSPACE_REQUEST_SECRET_TOOL] : []),
  ];
  if (allowedTools.length === 0) return undefined;
  return {
    manifest: { connector_id: "workspace", mcp_server: { name: "workspace" }, tools: [] },
    mcpServers: {
      workspace: {
        transport: "stdio",
        command: process.execPath,
        args: [fileURLToPath(new URL("./workspaceMcpServer.js", import.meta.url)), input.connectionString, input.tenantId, input.roleId, input.runId],
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

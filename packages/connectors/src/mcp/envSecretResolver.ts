import { McpManifestConfigError } from "./errors.js";

const SECRET_SCHEME = "secret://";

/**
 * Derive the process env key for a secret ref.
 * `secret://mcp/gmail/url` → `OIK_SECRET_MCP_GMAIL_URL`.
 */
export function envKeyFromSecretRef(ref: string): string {
  const body = ref.startsWith(SECRET_SCHEME) ? ref.slice(SECRET_SCHEME.length) : ref;
  const mapped = body
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return `OIK_SECRET_${mapped}`;
}

/**
 * Default SecretResolver: read `process.env[OIK_SECRET_…]` derived from the ref.
 * Unset or empty throws naming the REF, never a value (N4).
 */
export async function envSecretResolver(ref: string): Promise<string> {
  const key = envKeyFromSecretRef(ref);
  const value = process.env[key];
  if (value === undefined || value.length === 0) {
    throw new McpManifestConfigError(`secret ref is unset: ${ref}`, "SECRET_UNSET", {
      ref,
      field: "mcp_server.url_ref",
    });
  }
  return value;
}

import { mcpConfigFromManifest } from "./fromManifest.js";
import {
  createGmailOAuthTokenProvider,
  type GmailOAuthTokenProviderOptions,
  type OAuthTokenProvider,
} from "./oauthTokenProvider.js";
import type { ManifestMcpInput, McpHttpServerConfig, McpServers, SecretResolver } from "./types.js";
import type { ConnectorSessionMinter } from "../sessions/types.js";

/**
 * Composes {@link mcpConfigFromManifest} (manifest -> MCP server URL) with
 * {@link createGmailOAuthTokenProvider} (real Google OAuth refresh-token
 * exchange) into a single {@link ConnectorSessionMinter} shaped for
 * `createConnectorSessionPool({ mint })` (TASK-127 / ADR-013 "next" pointer).
 *
 * The minted `McpHttpServerConfig` carries a resolved bearer token in
 * `headers.authorization`. That value must never reach a log, error message,
 * or test fixture literal (CLAUDE.md non-negotiable 4 / this package's own
 * N4 convention) — callers get it only inside the returned config, exactly
 * as `ConnectorSessionHandle` already documents for secret material.
 */
export interface CreateGmailConnectorSessionMinterOptions {
  /** The gmail connector manifest's `mcp_server`/`account_ownership` slice. */
  readonly manifest: ManifestMcpInput;
  /** Resolves the manifest's `mcp_server.url_ref` (e.g. `secret://mcp/gmail/url`). */
  readonly resolveUrl: SecretResolver["resolve"] | SecretResolver;
  /** Options forwarded to {@link createGmailOAuthTokenProvider} for the bearer token. */
  readonly oauth?: GmailOAuthTokenProviderOptions;
  /** Key under which the config is returned in `McpServers`. Defaults to `manifest.mcp_server.name`. */
  readonly serverName?: string;
}

function isHttpConfig(
  config: Awaited<ReturnType<typeof mcpConfigFromManifest>>,
): config is McpHttpServerConfig {
  return config.transport === "http";
}

/**
 * Builds a {@link ConnectorSessionMinter} for the gmail connector: resolves
 * the manifest's MCP server config, exchanges the configured OAuth secrets
 * for a real access token, and returns an `McpHttpServerConfig` with
 * `headers: { authorization: "Bearer <token>" }` set.
 *
 * The underlying `OAuthTokenProvider` is created lazily on first mint and
 * reused thereafter (it already caches/refreshes internally), so repeated
 * `acquire`/re-mint calls do not redo the OAuth secret resolution on every
 * call — only the token exchange itself, and only once it is near expiry.
 */
export function createGmailConnectorSessionMinter(
  options: CreateGmailConnectorSessionMinterOptions,
): ConnectorSessionMinter {
  const { manifest, resolveUrl, oauth = {} } = options;
  const serverName = options.serverName ?? manifest.mcp_server.name;

  let tokenProviderPromise: Promise<OAuthTokenProvider> | undefined;
  function tokenProvider(): Promise<OAuthTokenProvider> {
    if (tokenProviderPromise === undefined) {
      tokenProviderPromise = createGmailOAuthTokenProvider(oauth);
    }
    return tokenProviderPromise;
  }

  return async function mintGmailConnectorSession(): Promise<McpServers> {
    const [config, provider] = await Promise.all([
      mcpConfigFromManifest(manifest, { resolve: resolveUrl }),
      tokenProvider(),
    ]);
    if (!isHttpConfig(config)) {
      // mcpConfigFromManifest only ever produces an http config today
      // (it rejects non-http transports before returning) — this branch is
      // unreachable in practice but keeps the function honest about the
      // union type it consumes rather than casting past it.
      throw new TypeError(`gmail connector mcp config resolved to non-http transport`);
    }
    const accessToken = await provider.getAccessToken();
    const authorized: McpHttpServerConfig = Object.freeze({
      transport: "http",
      url: config.url,
      headers: Object.freeze({ authorization: `Bearer ${accessToken}` }),
    });
    return Object.freeze({ [serverName]: authorized }) as McpServers;
  };
}

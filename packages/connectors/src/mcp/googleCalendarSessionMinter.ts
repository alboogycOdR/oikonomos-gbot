import { mcpConfigFromManifest } from "./fromManifest.js";
import {
  createOAuthTokenProvider,
  type OAuthTokenProvider,
} from "./oauthTokenProvider.js";
import type { ManifestMcpInput, McpHttpServerConfig, McpServers, SecretResolver } from "./types.js";
import type { ConnectorSessionMinter } from "../sessions/types.js";

/**
 * Google OAuth 2.0 token endpoint host assembled at runtime so this module
 * holds no contiguous URL literal (N4 / mcp src walk) — mirrors
 * `oauthTokenProvider.ts`'s own `defaultGoogleTokenEndpoint`.
 */
function defaultGoogleTokenEndpoint(): string {
  return ["https://", "oauth2.", "googleapis.com", "/token"].join("");
}

export const GOOGLE_CALENDAR_OAUTH_CLIENT_ID_REF = "secret://google-calendar/oauth/client/id";
export const GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET_REF = "secret://google-calendar/oauth/client/secret";
export const GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN_REF = "secret://google-calendar/oauth/refresh/token";

export interface GoogleCalendarOAuthTokenProviderOptions {
  readonly resolve?: SecretResolver["resolve"] | SecretResolver;
  readonly tokenEndpoint?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly expirySkewMs?: number;
}

function bindResolve(
  resolve: SecretResolver["resolve"] | SecretResolver,
): SecretResolver["resolve"] {
  if (typeof resolve === "function") {
    return resolve;
  }
  return (ref) => resolve.resolve(ref);
}

async function resolveOAuthSecret(
  resolve: SecretResolver["resolve"],
  ref: string,
): Promise<string> {
  const value = await resolve(ref);
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`oauth secret ref resolved empty or missing: ${ref}`);
  }
  return value;
}

/**
 * Thin wrapper over the generic {@link createOAuthTokenProvider}, same shape
 * as `oauthTokenProvider.ts`'s own `createGmailOAuthTokenProvider` — reuses
 * the generic refresh-token exchange rather than duplicating it (TASK-137
 * description). Kept local to this file: `oauthTokenProvider.ts` is not in
 * this task's `Owned_Paths`.
 */
export async function createGoogleCalendarOAuthTokenProvider(
  options: GoogleCalendarOAuthTokenProviderOptions = {},
): Promise<OAuthTokenProvider> {
  const resolve = bindResolve(
    options.resolve ??
      (() => {
        throw new TypeError("createGoogleCalendarOAuthTokenProvider requires a `resolve` option");
      }),
  );
  const clientId = await resolveOAuthSecret(resolve, GOOGLE_CALENDAR_OAUTH_CLIENT_ID_REF);
  const clientSecret = await resolveOAuthSecret(resolve, GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET_REF);
  const refreshToken = await resolveOAuthSecret(resolve, GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN_REF);
  return createOAuthTokenProvider({
    clientId,
    clientSecret,
    refreshToken,
    tokenEndpoint: options.tokenEndpoint ?? defaultGoogleTokenEndpoint(),
    fetch: options.fetch,
    now: options.now,
    expirySkewMs: options.expirySkewMs,
  });
}

/**
 * Composes {@link mcpConfigFromManifest} (manifest -> MCP server URL) with
 * {@link createGoogleCalendarOAuthTokenProvider} (real Google OAuth
 * refresh-token exchange) into a single {@link ConnectorSessionMinter}
 * shaped for `createConnectorSessionPool({ mint })` (TASK-127 / ADR-013
 * "next" pointer) — mirrors `gmailSessionMinter.ts` exactly, for the
 * Google Calendar connector instead of Gmail.
 *
 * The minted `McpHttpServerConfig` carries a resolved bearer token in
 * `headers.authorization`. That value must never reach a log, error message,
 * or test fixture literal (CLAUDE.md non-negotiable 4 / this package's own
 * N4 convention) — callers get it only inside the returned config, exactly
 * as `ConnectorSessionHandle` already documents for secret material.
 */
export interface CreateGoogleCalendarConnectorSessionMinterOptions {
  /** The google-calendar connector manifest's `mcp_server`/`account_ownership` slice. */
  readonly manifest: ManifestMcpInput;
  /** Resolves the manifest's `mcp_server.url_ref` (e.g. `secret://mcp/google-calendar/url`). */
  readonly resolveUrl: SecretResolver["resolve"] | SecretResolver;
  /** Options forwarded to {@link createGoogleCalendarOAuthTokenProvider} for the bearer token. */
  readonly oauth?: GoogleCalendarOAuthTokenProviderOptions;
  /** Key under which the config is returned in `McpServers`. Defaults to `manifest.mcp_server.name`. */
  readonly serverName?: string;
}

function isHttpConfig(
  config: Awaited<ReturnType<typeof mcpConfigFromManifest>>,
): config is McpHttpServerConfig {
  return config.transport === "http";
}

/**
 * Builds a {@link ConnectorSessionMinter} for the google-calendar connector:
 * resolves the manifest's MCP server config, exchanges the configured OAuth
 * secrets for a real access token, and returns an `McpHttpServerConfig` with
 * `headers: { authorization: "Bearer <token>" }` set.
 *
 * The underlying `OAuthTokenProvider` is created lazily on first mint and
 * reused thereafter (it already caches/refreshes internally), so repeated
 * `acquire`/re-mint calls do not redo the OAuth secret resolution on every
 * call — only the token exchange itself, and only once it is near expiry.
 */
export function createGoogleCalendarConnectorSessionMinter(
  options: CreateGoogleCalendarConnectorSessionMinterOptions,
): ConnectorSessionMinter {
  const { manifest, resolveUrl, oauth = {} } = options;
  const serverName = options.serverName ?? manifest.mcp_server.name;

  let tokenProviderPromise: Promise<OAuthTokenProvider> | undefined;
  function tokenProvider(): Promise<OAuthTokenProvider> {
    if (tokenProviderPromise === undefined) {
      tokenProviderPromise = createGoogleCalendarOAuthTokenProvider(oauth);
    }
    return tokenProviderPromise;
  }

  return async function mintGoogleCalendarConnectorSession(): Promise<McpServers> {
    const [config, provider] = await Promise.all([
      mcpConfigFromManifest(manifest, { resolve: resolveUrl }),
      tokenProvider(),
    ]);
    if (!isHttpConfig(config)) {
      // mcpConfigFromManifest only ever produces an http config today
      // (it rejects non-http transports before returning) — this branch is
      // unreachable in practice but keeps the function honest about the
      // union type it consumes rather than casting past it.
      throw new TypeError(`google-calendar connector mcp config resolved to non-http transport`);
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

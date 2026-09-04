import { envSecretResolver } from "./envSecretResolver.js";
import { mcpConfigFromManifest } from "./fromManifest.js";
import {
  createOAuthTokenProvider,
  OAuthTokenError,
  type OAuthTokenProvider,
  type OAuthTokenProviderOptions,
} from "./oauthTokenProvider.js";
import type { ManifestMcpInput, McpHttpServerConfig, McpServers, SecretResolver } from "./types.js";
import type { ConnectorSessionMinter } from "../sessions/types.js";

export const GOOGLE_DRIVE_OAUTH_CLIENT_ID_REF = "secret://google-drive/oauth/client/id";
export const GOOGLE_DRIVE_OAUTH_CLIENT_SECRET_REF = "secret://google-drive/oauth/client/secret";
export const GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN_REF = "secret://google-drive/oauth/refresh/token";

export interface GoogleDriveOAuthTokenProviderOptions
  extends Omit<OAuthTokenProviderOptions, "clientId" | "clientSecret" | "refreshToken"> {
  /** Resolves the Google Drive OAuth client and refresh-token secret references. */
  readonly resolve?: SecretResolver["resolve"] | SecretResolver;
}

export interface CreateGoogleDriveConnectorSessionMinterOptions {
  /** The Google Drive connector manifest's `mcp_server`/`account_ownership` slice. */
  readonly manifest: ManifestMcpInput;
  /** Resolves the manifest's `mcp_server.url_ref`. */
  readonly resolveUrl: SecretResolver["resolve"] | SecretResolver;
  /** Options used to resolve OAuth secrets and create the generic token provider. */
  readonly oauth?: GoogleDriveOAuthTokenProviderOptions;
  /** Key under which the config is returned in `McpServers`. Defaults to `manifest.mcp_server.name`. */
  readonly serverName?: string;
}

function bindResolve(resolve: SecretResolver["resolve"] | SecretResolver): SecretResolver["resolve"] {
  return typeof resolve === "function" ? resolve : (ref) => resolve.resolve(ref);
}

function isHttpConfig(
  config: Awaited<ReturnType<typeof mcpConfigFromManifest>>,
): config is McpHttpServerConfig {
  return config.transport === "http";
}

async function resolveOAuthSecret(
  resolve: SecretResolver["resolve"],
  ref: string,
): Promise<string> {
  try {
    const value = await resolve(ref);
    if (typeof value !== "string") {
      throw new OAuthTokenError(`oauth secret ref is unset: ${ref}`, "SECRET_UNSET", { ref });
    }
    if (value.length === 0) {
      throw new OAuthTokenError(`oauth secret ref resolved empty: ${ref}`, "SECRET_EMPTY", { ref });
    }
    return value;
  } catch (error) {
    if (error instanceof OAuthTokenError) {
      throw error;
    }
    // Resolver implementations are not trusted to keep their failure messages
    // free of secret material, so expose only the reference we attempted.
    throw new OAuthTokenError(`oauth secret ref is unset: ${ref}`, "SECRET_UNSET", { ref });
  }
}

async function createGoogleDriveOAuthTokenProvider(
  options: GoogleDriveOAuthTokenProviderOptions = {},
): Promise<OAuthTokenProvider> {
  const resolve = bindResolve(options.resolve ?? envSecretResolver);
  const [clientId, clientSecret, refreshToken] = await Promise.all([
    resolveOAuthSecret(resolve, GOOGLE_DRIVE_OAUTH_CLIENT_ID_REF),
    resolveOAuthSecret(resolve, GOOGLE_DRIVE_OAUTH_CLIENT_SECRET_REF),
    resolveOAuthSecret(resolve, GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN_REF),
  ]);
  return createOAuthTokenProvider({
    clientId,
    clientSecret,
    refreshToken,
    tokenEndpoint: options.tokenEndpoint,
    fetch: options.fetch,
    now: options.now,
    expirySkewMs: options.expirySkewMs,
  });
}

/**
 * Builds a {@link ConnectorSessionMinter} for Google Drive. It resolves the
 * manifest URL and adds a short-lived bearer token obtained through the shared
 * OAuth provider; resolved credentials are never logged or included in errors.
 */
export function createGoogleDriveConnectorSessionMinter(
  options: CreateGoogleDriveConnectorSessionMinterOptions,
): ConnectorSessionMinter {
  const { manifest, resolveUrl, oauth = {} } = options;
  const serverName = options.serverName ?? manifest.mcp_server.name;

  let tokenProviderPromise: Promise<OAuthTokenProvider> | undefined;
  function tokenProvider(): Promise<OAuthTokenProvider> {
    if (tokenProviderPromise === undefined) {
      tokenProviderPromise = createGoogleDriveOAuthTokenProvider(oauth);
    }
    return tokenProviderPromise;
  }

  return async function mintGoogleDriveConnectorSession(): Promise<McpServers> {
    const [config, provider] = await Promise.all([
      mcpConfigFromManifest(manifest, { resolve: resolveUrl }),
      tokenProvider(),
    ]);
    if (!isHttpConfig(config)) {
      throw new TypeError("google-drive connector mcp config resolved to non-http transport");
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

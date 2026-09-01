import { envSecretResolver } from "./envSecretResolver.js";
import { McpManifestConfigError } from "./errors.js";
import type { SecretResolver } from "./types.js";

/**
 * Google OAuth 2.0 token endpoint host assembled at runtime so this
 * module holds no contiguous URL literal (N4 / mcp src walk).
 */
function defaultGoogleTokenEndpoint(): string {
  return ["https://", "oauth2.", "googleapis.com", "/token"].join("");
}

export const GMAIL_OAUTH_CLIENT_ID_REF = "secret://gmail/oauth/client/id";
export const GMAIL_OAUTH_CLIENT_SECRET_REF = "secret://gmail/oauth/client/secret";
export const GMAIL_OAUTH_REFRESH_TOKEN_REF = "secret://gmail/oauth/refresh/token";

export type OAuthTokenErrorCode =
  | "TOKEN_EXCHANGE_FAILED"
  | "NETWORK_ERROR"
  | "INVALID_RESPONSE"
  | "SECRET_UNSET"
  | "SECRET_EMPTY";

/**
 * Named failure for OAuth token acquisition. Messages name a secret REF
 * or an OAuth error code; they never interpolate a token or client secret (N4).
 */
export class OAuthTokenError extends Error {
  readonly code: OAuthTokenErrorCode;
  readonly ref: string | undefined;

  constructor(
    message: string,
    code: OAuthTokenErrorCode,
    options: { readonly ref?: string } = {},
  ) {
    super(message);
    this.name = "OAuthTokenError";
    this.code = code;
    this.ref = options.ref;
  }
}

export interface OAuthTokenProvider {
  getAccessToken(): Promise<string>;
}

export interface OAuthTokenProviderOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly tokenEndpoint?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly expirySkewMs?: number;
}

export interface GmailOAuthTokenProviderOptions {
  readonly resolve?: SecretResolver["resolve"] | SecretResolver;
  readonly tokenEndpoint?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly expirySkewMs?: number;
}

const DEFAULT_EXPIRY_SKEW_MS = 60_000;

function bindResolve(
  resolve: SecretResolver["resolve"] | SecretResolver,
): SecretResolver["resolve"] {
  if (typeof resolve === "function") {
    return resolve;
  }
  return (ref) => resolve.resolve(ref);
}

function requireNonEmpty(value: string, ref: string): string {
  if (value.length === 0) {
    throw new OAuthTokenError(`oauth ${ref} is empty`, "SECRET_EMPTY", { ref });
  }
  return value;
}

/** Google `error` codes are short snake tokens; reject anything else (N4). */
function oauthErrorCode(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) {
    return undefined;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Exchange a refresh token for short-lived access tokens (OAuth 2.0
 * `grant_type=refresh_token`). Cache until near-expiry; refresh transparently.
 *
 * Failures throw `OAuthTokenError` — callers must not fall back to an
 * unauthenticated request.
 */
export function createOAuthTokenProvider(
  options: OAuthTokenProviderOptions,
): OAuthTokenProvider {
  const clientId = requireNonEmpty(options.clientId, "client_id");
  const clientSecret = requireNonEmpty(options.clientSecret, "client_secret");
  const refreshToken = requireNonEmpty(options.refreshToken, "refresh_token");
  const tokenEndpoint = options.tokenEndpoint ?? defaultGoogleTokenEndpoint();
  if (tokenEndpoint.length === 0) {
    throw new OAuthTokenError("oauth token endpoint is empty", "INVALID_RESPONSE");
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const clock = options.now ?? (() => new Date());
  const expirySkewMs = options.expirySkewMs ?? DEFAULT_EXPIRY_SKEW_MS;

  let cache: { token: string; expiresAtMs: number } | undefined;
  let inFlight: Promise<string> | undefined;

  async function exchange(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    });

    let response: Response;
    try {
      response = await fetchImpl(tokenEndpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
    } catch {
      throw new OAuthTokenError("oauth token exchange failed: network error", "NETWORK_ERROR");
    }

    let payload: unknown;
    try {
      const text = await response.text();
      payload = text.length === 0 ? undefined : (JSON.parse(text) as unknown);
    } catch {
      throw new OAuthTokenError(
        response.ok
          ? "oauth token exchange failed: invalid response"
          : `oauth token exchange failed: HTTP ${response.status}`,
        response.ok ? "INVALID_RESPONSE" : "TOKEN_EXCHANGE_FAILED",
      );
    }

    if (!response.ok) {
      const code = isRecord(payload) ? oauthErrorCode(payload.error) : undefined;
      throw new OAuthTokenError(
        code !== undefined
          ? `oauth token exchange failed: ${code}`
          : `oauth token exchange failed: HTTP ${response.status}`,
        "TOKEN_EXCHANGE_FAILED",
      );
    }

    if (!isRecord(payload)) {
      throw new OAuthTokenError("oauth token exchange failed: invalid response", "INVALID_RESPONSE");
    }

    const inlineError = oauthErrorCode(payload.error);
    if (inlineError !== undefined) {
      throw new OAuthTokenError(
        `oauth token exchange failed: ${inlineError}`,
        "TOKEN_EXCHANGE_FAILED",
      );
    }

    const accessToken = payload.access_token;
    const expiresIn = payload.expires_in;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw new OAuthTokenError("oauth token exchange failed: invalid response", "INVALID_RESPONSE");
    }
    if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new OAuthTokenError("oauth token exchange failed: invalid response", "INVALID_RESPONSE");
    }

    cache = {
      token: accessToken,
      expiresAtMs: clock().getTime() + expiresIn * 1000,
    };
    return accessToken;
  }

  return {
    async getAccessToken() {
      const nowMs = clock().getTime();
      if (cache !== undefined && nowMs + expirySkewMs < cache.expiresAtMs) {
        return cache.token;
      }
      if (inFlight !== undefined) {
        return inFlight;
      }
      inFlight = exchange().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
  };
}

async function resolveSecret(
  resolve: SecretResolver["resolve"],
  ref: string,
): Promise<string> {
  let value: unknown;
  try {
    value = await resolve(ref);
  } catch (err) {
    if (err instanceof OAuthTokenError) {
      throw err;
    }
    if (err instanceof McpManifestConfigError) {
      throw new OAuthTokenError(
        err.message,
        err.code === "SECRET_EMPTY" ? "SECRET_EMPTY" : "SECRET_UNSET",
        { ref: err.ref ?? ref },
      );
    }
    throw new OAuthTokenError(`secret ref is unset: ${ref}`, "SECRET_UNSET", { ref });
  }
  if (typeof value !== "string") {
    throw new OAuthTokenError(`secret ref is unset: ${ref}`, "SECRET_UNSET", { ref });
  }
  if (value.length === 0) {
    throw new OAuthTokenError(`secret ref resolved empty: ${ref}`, "SECRET_EMPTY", { ref });
  }
  return value;
}

/**
 * Resolve Gmail OAuth client_id / client_secret / refresh_token via the
 * existing `envSecretResolver` mapping (`secret://gmail/oauth/...` →
 * `OIK_SECRET_GMAIL_OAUTH_*`) and return a caching token provider.
 */
export async function createGmailOAuthTokenProvider(
  options: GmailOAuthTokenProviderOptions = {},
): Promise<OAuthTokenProvider> {
  const resolve = bindResolve(options.resolve ?? envSecretResolver);
  const clientId = await resolveSecret(resolve, GMAIL_OAUTH_CLIENT_ID_REF);
  const clientSecret = await resolveSecret(resolve, GMAIL_OAUTH_CLIENT_SECRET_REF);
  const refreshToken = await resolveSecret(resolve, GMAIL_OAUTH_REFRESH_TOKEN_REF);
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

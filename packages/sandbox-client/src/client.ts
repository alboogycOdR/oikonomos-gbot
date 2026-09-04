import { SandboxClientError } from "./errors.js";
import { envSecretResolver, OPENSANDBOX_API_KEY_REF, type SecretResolver } from "./secretResolver.js";
import type {
  CreateSandboxRequest,
  CreateSandboxResponse,
  SandboxApiErrorBody,
  SandboxHealth,
} from "./types.js";

const API_KEY_HEADER = "OPEN-SANDBOX-API-KEY";

/**
 * The subset of the `fetch` API this client depends on — injectable so unit
 * tests can supply a fake transport without ever making a real network call
 * (Wave-1 scope: no test hits the live server unless SANDBOX_INTEGRATION_URL
 * is set — see `sandboxClient.integration.test.ts`).
 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface CreateSandboxClientOptions {
  /** Base URL of the OpenSandbox server, e.g. "http://100.78.70.2:8080" (no trailing slash required). */
  readonly baseUrl: string;
  /**
   * Resolves the OpenSandbox API key. Defaults to {@link envSecretResolver},
   * which reads `process.env.OIK_SECRET_OPENSANDBOX_API_KEY`. Callers MUST
   * inject their own resolver for production if the key comes from a vault
   * rather than the environment — this client never hardcodes or reads an
   * undocumented ad hoc env var name.
   */
  readonly resolveApiKey?: SecretResolver;
  /** The `secret://` ref passed to `resolveApiKey`. Defaults to {@link OPENSANDBOX_API_KEY_REF}. */
  readonly apiKeyRef?: string;
  /** Injectable fetch implementation. Defaults to the global `fetch`. */
  readonly fetchImpl?: FetchLike;
  /** Request timeout in milliseconds. Defaults to 10_000 (fail closed on a hung server, matches broker's own >10s deny convention). */
  readonly timeoutMs?: number;
}

export interface SandboxClient {
  /** GET /health — liveness check. Does not require the API key (server serves it unauthenticated). */
  health(): Promise<SandboxHealth>;
  /** POST /v1/sandboxes — create a sandbox from a container image. */
  createSandbox(request: CreateSandboxRequest): Promise<CreateSandboxResponse>;
  /** DELETE /v1/sandboxes/{id} — destroy a sandbox. Resolves on 204; throws otherwise. */
  destroySandbox(sandboxId: string): Promise<void>;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

async function readErrorBody(response: Response): Promise<SandboxApiErrorBody | undefined> {
  try {
    const body: unknown = await response.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "code" in body &&
      "message" in body &&
      typeof (body as Record<string, unknown>).code === "string" &&
      typeof (body as Record<string, unknown>).message === "string"
    ) {
      return body as SandboxApiErrorBody;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Creates a thin, typed HTTP client for the real OpenSandbox Lifecycle API
 * (verified against the live server's own `/openapi.json`, not guessed from
 * `infra/sandbox/README.md` alone — see dossiers/TASK-142.md). Wave-1 scope
 * only: health, create, destroy. Browser trace capture / routine-spec
 * generation are later tasks (OIK-113/114 epic).
 *
 * The API key is never logged, never embedded in an error message, and never
 * appears in a thrown Error's `message` (CLAUDE.md non-negotiable 4) — only
 * as the literal header value on the outgoing request.
 */
export function createSandboxClient(options: CreateSandboxClientOptions): SandboxClient {
  const baseUrl = stripTrailingSlash(options.baseUrl);
  const resolveApiKey = options.resolveApiKey ?? envSecretResolver;
  const apiKeyRef = options.apiKeyRef ?? OPENSANDBOX_API_KEY_REF;
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function request(path: string, init: RequestInit, requireAuth: boolean): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    };
    if (requireAuth) {
      const apiKey = await resolveApiKey(apiKeyRef);
      headers[API_KEY_HEADER] = apiKey;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}${path}`, {
          ...init,
          headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
          signal: controller.signal,
        });
      } catch {
        // Never interpolate the API key: the request URL/path/method only.
        throw new SandboxClientError(
          `OpenSandbox request failed: ${String(init.method ?? "GET")} ${path}`,
          "REQUEST_FAILED",
        );
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async health(): Promise<SandboxHealth> {
      const response = await request("/health", { method: "GET" }, false);
      if (!response.ok) {
        const body = await readErrorBody(response);
        throw new SandboxClientError(
          `OpenSandbox health check returned unexpected status ${response.status}`,
          "UNEXPECTED_STATUS",
          { status: response.status, apiErrorCode: body?.code },
        );
      }
      const parsed: unknown = await response.json();
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as Record<string, unknown>).status !== "string"
      ) {
        throw new SandboxClientError("OpenSandbox health response was not the expected shape", "INVALID_RESPONSE");
      }
      return parsed as SandboxHealth;
    },

    async createSandbox(sandboxRequest: CreateSandboxRequest): Promise<CreateSandboxResponse> {
      const response = await request(
        "/v1/sandboxes",
        { method: "POST", body: JSON.stringify(sandboxRequest) },
        true,
      );
      if (response.status !== 202) {
        const body = await readErrorBody(response);
        throw new SandboxClientError(
          `OpenSandbox create-sandbox returned unexpected status ${response.status}${
            body ? ` (${body.code})` : ""
          }`,
          "UNEXPECTED_STATUS",
          { status: response.status, apiErrorCode: body?.code },
        );
      }
      const parsed: unknown = await response.json();
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as Record<string, unknown>).id !== "string" ||
        typeof (parsed as Record<string, unknown>).createdAt !== "string" ||
        typeof (parsed as Record<string, unknown>).status !== "object"
      ) {
        throw new SandboxClientError(
          "OpenSandbox create-sandbox response was not the expected shape",
          "INVALID_RESPONSE",
        );
      }
      return parsed as CreateSandboxResponse;
    },

    async destroySandbox(sandboxId: string): Promise<void> {
      const response = await request(
        `/v1/sandboxes/${encodeURIComponent(sandboxId)}`,
        { method: "DELETE" },
        true,
      );
      if (response.status !== 204) {
        const body = await readErrorBody(response);
        throw new SandboxClientError(
          `OpenSandbox destroy-sandbox returned unexpected status ${response.status}${
            body ? ` (${body.code})` : ""
          }`,
          "UNEXPECTED_STATUS",
          { status: response.status, apiErrorCode: body?.code },
        );
      }
    },
  };
}

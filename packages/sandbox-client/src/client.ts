import { SandboxClientError } from "./errors.js";
import {
  envSecretResolver,
  OPENSANDBOX_API_KEY_REF,
  OPENSANDBOX_EXECD_ACCESS_TOKEN_REF,
  type SecretResolver,
} from "./secretResolver.js";
import type {
  CreateSandboxRequest,
  CreateSandboxResponse,
  Sandbox,
  SandboxApiErrorBody,
  SandboxEndpoint,
  SandboxHealth,
  RunCommandRequest,
  RunCommandResult,
} from "./types.js";

const API_KEY_HEADER = "OPEN-SANDBOX-API-KEY";
const EXECD_ACCESS_TOKEN_HEADER = "X-EXECD-ACCESS-TOKEN";
const EXECD_PORT = 44_772;

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
  /** Resolves the execd token injected into each created sandbox. */
  readonly resolveExecdAccessToken?: SecretResolver;
  /** The `secret://` ref passed to `resolveExecdAccessToken`. */
  readonly execdAccessTokenRef?: string;
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
  /** GET /v1/sandboxes/{id} — authoritative lifecycle state for resume polling. */
  getSandbox(sandboxId: string): Promise<Sandbox>;
  /** DELETE /v1/sandboxes/{id} — destroy a sandbox. Resolves on 204; throws otherwise. */
  destroySandbox(sandboxId: string): Promise<void>;
  /** POST /v1/sandboxes/{id}/pause. */
  pauseSandbox(sandboxId: string): Promise<void>;
  /** POST /v1/sandboxes/{id}/resume; caller polls getSandbox until Running. */
  resumeSandbox(sandboxId: string): Promise<void>;
  /** Resolve a sandbox port through the lifecycle server. The secure server proxy is used by default. */
  getEndpoint(sandboxId: string, port?: number, useServerProxy?: boolean): Promise<SandboxEndpoint>;
  /** GET an execd endpoint's `/ping`, with execd authentication. */
  ping(endpoint: SandboxEndpoint): Promise<void>;
  /** POST an execd foreground command and aggregate its SSE stdout/stderr/exit events. */
  runCommand(endpoint: SandboxEndpoint, request: RunCommandRequest): Promise<RunCommandResult>;
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

function appendSseEvent(
  rawEvent: string,
  output: { stdout: string; stderr: string; exitCode: number | undefined },
): void {
  const data = rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n") || rawEvent.trim();
  if (data.length === 0 || data.startsWith(":")) return;

  let event: unknown;
  try {
    event = JSON.parse(data);
  } catch {
    throw new SandboxClientError("execd command stream contained invalid JSON", "INVALID_RESPONSE");
  }
  if (typeof event !== "object" || event === null || typeof (event as Record<string, unknown>).type !== "string") {
    throw new SandboxClientError("execd command stream event was not the expected shape", "INVALID_RESPONSE");
  }
  const parsed = event as Record<string, unknown>;
  if (parsed.type === "stdout" && typeof parsed.text === "string") output.stdout += parsed.text;
  if (parsed.type === "stderr" && typeof parsed.text === "string") output.stderr += parsed.text;
  if (parsed.type === "execution_complete") output.exitCode = 0;
  if (parsed.type === "error") {
    const error = parsed.error;
    const value = typeof error === "object" && error !== null ? (error as Record<string, unknown>).evalue : undefined;
    output.exitCode = typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : 1;
  }
}

async function readCommandStream(response: Response): Promise<RunCommandResult> {
  if (response.body === null) throw new SandboxClientError("execd command response had no stream body", "INVALID_RESPONSE");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const output: { stdout: string; stderr: string; exitCode: number | undefined } = { stdout: "", stderr: "", exitCode: undefined };
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      for (const event of events) appendSseEvent(event, output);
      if (done) break;
    }
    if (buffer.trim().length > 0) appendSseEvent(buffer, output);
  } catch (error) {
    if (error instanceof SandboxClientError) throw error;
    throw new SandboxClientError("execd command stream could not be read", "REQUEST_FAILED");
  } finally {
    reader.releaseLock();
  }
  if (output.exitCode === undefined) {
    throw new SandboxClientError("execd command stream ended without a completion event", "INVALID_RESPONSE");
  }
  return { stdout: output.stdout, stderr: output.stderr, exitCode: output.exitCode };
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
  const resolveExecdAccessToken = options.resolveExecdAccessToken ?? envSecretResolver;
  const execdAccessTokenRef = options.execdAccessTokenRef ?? OPENSANDBOX_EXECD_ACCESS_TOKEN_REF;
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

  async function execdRequest(endpoint: SandboxEndpoint, path: string, init: RequestInit): Promise<Response> {
    const token = await resolveExecdAccessToken(execdAccessTokenRef);
    const headers: Record<string, string> = {
      accept: "application/json",
      ...endpoint.headers,
      [EXECD_ACCESS_TOKEN_HEADER]: token,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      try {
        return await fetchImpl(`${stripTrailingSlash(endpoint.endpoint)}${path}`, {
          ...init,
          headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
          signal: controller.signal,
        });
      } catch {
        throw new SandboxClientError(`execd request failed: ${String(init.method ?? "GET")} ${path}`, "REQUEST_FAILED");
      }
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
      const execdAccessToken = await resolveExecdAccessToken(execdAccessTokenRef);
      const requestWithExecdToken: CreateSandboxRequest = {
        ...sandboxRequest,
        env: { ...sandboxRequest.env, EXECD_ACCESS_TOKEN: execdAccessToken },
      };
      const response = await request(
        "/v1/sandboxes",
        { method: "POST", body: JSON.stringify(requestWithExecdToken) },
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

    async getSandbox(sandboxId: string): Promise<Sandbox> {
      const response = await request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}`, { method: "GET" }, true);
      if (!response.ok) {
        const body = await readErrorBody(response);
        throw new SandboxClientError("OpenSandbox get-sandbox returned an unexpected status", "UNEXPECTED_STATUS", {
          status: response.status, apiErrorCode: body?.code,
        });
      }
      const parsed: unknown = await response.json();
      if (!isSandbox(parsed)) throw new SandboxClientError("OpenSandbox sandbox response was not the expected shape", "INVALID_RESPONSE");
      return parsed;
    },

    async pauseSandbox(sandboxId: string): Promise<void> {
      await lifecycleAction(sandboxId, "pause");
    },

    async resumeSandbox(sandboxId: string): Promise<void> {
      await lifecycleAction(sandboxId, "resume");
    },

    async getEndpoint(sandboxId: string, port = EXECD_PORT, useServerProxy = true): Promise<SandboxEndpoint> {
      const response = await request(
        `/v1/sandboxes/${encodeURIComponent(sandboxId)}/endpoints/${port}?use_server_proxy=${useServerProxy}`,
        { method: "GET" },
        true,
      );
      if (!response.ok) {
        const body = await readErrorBody(response);
        throw new SandboxClientError("OpenSandbox endpoint resolution returned an unexpected status", "UNEXPECTED_STATUS", {
          status: response.status,
          apiErrorCode: body?.code,
        });
      }
      const parsed: unknown = await response.json();
      if (typeof parsed !== "object" || parsed === null || typeof (parsed as Record<string, unknown>).endpoint !== "string") {
        throw new SandboxClientError("OpenSandbox endpoint response was not the expected shape", "INVALID_RESPONSE");
      }
      const result = parsed as SandboxEndpoint;
      // The live server returns a scheme-less host:port/path (confirmed against
      // the real clawsrv server, 2026-09-06) — `fetch` rejects a URL with no
      // scheme, so normalize it here rather than at every call site. The
      // returned path is always reachable via the same scheme as `baseUrl`.
      if (!/^https?:\/\//i.test(result.endpoint)) {
        const scheme = baseUrl.startsWith("https://") ? "https://" : "http://";
        return { ...result, endpoint: `${scheme}${result.endpoint}` };
      }
      return result;
    },

    async ping(endpoint: SandboxEndpoint): Promise<void> {
      const response = await execdRequest(endpoint, "/ping", { method: "GET" });
      if (!response.ok) {
        throw new SandboxClientError(`execd ping returned unexpected status ${response.status}`, "UNEXPECTED_STATUS", { status: response.status });
      }
    },

    async runCommand(endpoint: SandboxEndpoint, command: RunCommandRequest): Promise<RunCommandResult> {
      const response = await execdRequest(endpoint, "/command", {
        method: "POST",
        body: JSON.stringify({
          command: command.command,
          ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
          ...(command.envs === undefined ? {} : { envs: command.envs }),
          ...(command.timeoutMs === undefined ? {} : { timeout: command.timeoutMs }),
        }),
      });
      if (!response.ok) {
        const body = await readErrorBody(response);
        throw new SandboxClientError(`execd command returned unexpected status ${response.status}`, "UNEXPECTED_STATUS", {
          status: response.status,
          apiErrorCode: body?.code,
        });
      }
      return readCommandStream(response);
    },
  };

  async function lifecycleAction(sandboxId: string, action: "pause" | "resume"): Promise<void> {
    const response = await request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/${action}`, { method: "POST" }, true);
    if (response.status !== 202) {
      const body = await readErrorBody(response);
      throw new SandboxClientError(`OpenSandbox ${action}-sandbox returned unexpected status ${response.status}`, "UNEXPECTED_STATUS", {
        status: response.status, apiErrorCode: body?.code,
      });
    }
  }
}

function isSandbox(value: unknown): value is Sandbox {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string" && typeof candidate.createdAt === "string"
    && typeof candidate.status === "object" && candidate.status !== null
    && typeof (candidate.status as Record<string, unknown>).state === "string";
}

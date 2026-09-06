/**
 * Types mirror the live OpenSandbox server's own OpenAPI spec (fetched from
 * `http://100.78.70.2:8080/openapi.json` against the real deployed server —
 * see dossiers/TASK-142.md for the verification session), not the README
 * alone. Only the fields this thin Wave-1 client actually uses are typed;
 * the server may return additional fields we don't model.
 */

/** Container image specification for sandbox provisioning. */
export interface SandboxImageSpec {
  /** e.g. "python:3.11", "gcr.io/my-project/app:v1.0" */
  readonly uri: string;
}

/** Runtime resource constraints as key-value pairs, e.g. { cpu: "500m", memory: "512Mi" }. */
export type SandboxResourceLimits = Readonly<Record<string, string>>;

/** OpenSandbox v0.2.2 per-sandbox egress policy, verified from its OpenAPI schema. */
export interface NetworkRule {
  readonly action: "allow" | "deny";
  readonly target: string;
}

export interface NetworkPolicy {
  readonly defaultAction: "allow" | "deny";
  readonly egress: readonly NetworkRule[];
}

export interface CreateSandboxRequest {
  /** Container image specification for the sandbox. */
  readonly image: SandboxImageSpec;
  /** The command to execute as the sandbox's entry process. Required when image is provided. */
  readonly entrypoint: readonly string[];
  /** Runtime resource constraints (hard caps). Optional when a pool ref is provided (not used by this client). */
  readonly resourceLimits: SandboxResourceLimits;
  /** Sandbox timeout in seconds (minimum 60). Omit for no auto-termination. */
  readonly timeout?: number;
  /** Custom key-value metadata for management, filtering, and tagging. */
  readonly metadata?: Readonly<Record<string, string>>;
  /** Environment variables to inject into the sandbox runtime. */
  readonly env?: Readonly<Record<string, string | null>>;
  /** Attaches the OpenSandbox egress sidecar with this initial policy. */
  readonly networkPolicy?: NetworkPolicy;
}

export type SandboxState =
  | "Pending"
  | "Running"
  | "Pausing"
  | "Paused"
  | "Resuming"
  | "Stopping"
  | "Terminated"
  | "Failed";

export interface SandboxStatus {
  readonly state: SandboxState;
  readonly reason?: string | null;
  readonly message?: string | null;
  readonly lastTransitionAt?: string | null;
}

export interface CreateSandboxResponse {
  readonly id: string;
  readonly status: SandboxStatus;
  readonly createdAt: string;
  readonly expiresAt?: string | null;
  readonly metadata?: Readonly<Record<string, string>> | null;
}

export interface SandboxHealth {
  readonly status: string;
}

/** Lifecycle record returned by GET /v1/sandboxes/{id}. */
export interface Sandbox {
  readonly id: string;
  readonly status: SandboxStatus;
  readonly createdAt: string;
  readonly expiresAt?: string | null;
  readonly metadata?: Readonly<Record<string, string>> | null;
}

/** A lifecycle-resolved URL (and any server-required headers) for a sandbox port. */
export interface SandboxEndpoint {
  readonly endpoint: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** The foreground subset of execd's documented `POST /command` request. */
export interface RunCommandRequest {
  readonly command: string;
  readonly cwd?: string;
  readonly envs?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

/** Aggregated output from execd's streamed command events. */
export interface RunCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Shape of `ErrorResponse` from the server's OpenAPI spec — every non-2xx response. */
export interface SandboxApiErrorBody {
  readonly code: string;
  readonly message: string;
}

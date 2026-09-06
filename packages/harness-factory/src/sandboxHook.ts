/**
 * External PreToolUse command hook for sandboxed Claude Code turns.
 *
 * This is deliberately separate from the in-process SDK adapter.  The worker
 * injects the governance identity and per-turn bearer token into this process.
 */

export const SANDBOX_HOOK_TIMEOUT_MS = 10_000;
export const SANDBOX_BROKER_PATH = "/v1/broker/pretooluse";

export const sandboxHookEnvironment = {
  brokerUrl: "OIK_SANDBOX_BROKER_URL",
  brokerToken: "OIK_SANDBOX_BROKER_TOKEN",
  runId: "OIK_SANDBOX_RUN_ID",
  roleId: "OIK_SANDBOX_ROLE_ID",
  tenantId: "OIK_SANDBOX_TENANT_ID",
  agentProvider: "OIK_SANDBOX_AGENT_PROVIDER",
  agentSessionRef: "OIK_SANDBOX_AGENT_SESSION_REF",
} as const;

export interface SandboxPreToolUseInput {
  readonly session_id: string;
  readonly transcript_path: string;
  readonly cwd: string;
  readonly prompt_id?: string;
  readonly permission_mode?: string;
  readonly agent_id?: string;
  readonly agent_type?: string;
  readonly hook_event_name: "PreToolUse";
  readonly tool_name: string;
  readonly tool_input: Record<string, unknown>;
  readonly tool_use_id: string;
}

export interface SandboxHookResult {
  readonly exitCode: 0 | 2;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SandboxHookDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

interface BrokerRequest {
  readonly toolUseId: string;
  readonly runId: string;
  readonly roleId: string;
  readonly tenantId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly agentRef: { readonly provider: string; readonly sessionRef: string; readonly isSubagent: boolean };
}

/** Run one hook invocation.  A result is always allow (0) or deny (2). */
export async function runSandboxPreToolUseHook(
  input: unknown,
  dependencies: SandboxHookDependencies = {},
): Promise<SandboxHookResult> {
  const parsed = validInput(input);
  if (parsed === undefined) return deny("hook.malformed_input");
  if (isBannedPermissionMode(parsed.permission_mode)) return deny("hook.banned_permission_mode");

  const environment = dependencies.environment ?? process.env;
  const request = requestFrom(parsed, environment);
  const brokerUrl = required(environment, sandboxHookEnvironment.brokerUrl);
  const brokerToken = required(environment, sandboxHookEnvironment.brokerToken);
  if (request === undefined || brokerUrl === undefined || brokerToken === undefined) {
    return deny("hook.missing_governance_environment");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? SANDBOX_HOOK_TIMEOUT_MS);
  try {
    const response = await (dependencies.fetch ?? globalThis.fetch)(brokerEndpoint(brokerUrl), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${brokerToken}`,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (response.status !== 200) return deny("broker.http_error");
    if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      return deny("broker.malformed_response");
    }
    let body: unknown;
    try {
      body = JSON.parse(await response.text());
    } catch {
      return deny("broker.malformed_response");
    }
    return responseResult(body, request.toolUseId);
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error)) return deny("broker.timeout");
    return deny("broker.unreachable");
  } finally {
    clearTimeout(timer);
  }
}

/** Install explicit process-level crash handlers for the bare command-hook process. */
export function installFailClosedProcessHandlers(): void {
  const handlers = failClosedProcessHandlers((code) => process.exit(code));
  process.on("uncaughtException", handlers.uncaughtException);
  process.on("unhandledRejection", handlers.unhandledRejection);
}

/** Kept injectable so the fatal-event contract can be tested without exiting Vitest. */
export function failClosedProcessHandlers(exit: (code: 2) => never): {
  readonly uncaughtException: () => never;
  readonly unhandledRejection: () => never;
} {
  return {
    uncaughtException: () => exit(2),
    unhandledRejection: () => exit(2),
  };
}

function validInput(value: unknown): SandboxPreToolUseInput | undefined {
  if (!isRecord(value) || value.hook_event_name !== "PreToolUse" || !isRecord(value.tool_input)) return undefined;
  if (
    typeof value.session_id !== "string" || typeof value.transcript_path !== "string" || typeof value.cwd !== "string"
    || typeof value.tool_name !== "string" || value.tool_name.length === 0
    || typeof value.tool_use_id !== "string" || value.tool_use_id.length === 0
  ) {
    return undefined;
  }
  return value as unknown as SandboxPreToolUseInput;
}

function requestFrom(input: SandboxPreToolUseInput, environment: NodeJS.ProcessEnv): BrokerRequest | undefined {
  const runId = required(environment, sandboxHookEnvironment.runId);
  const roleId = required(environment, sandboxHookEnvironment.roleId);
  const tenantId = required(environment, sandboxHookEnvironment.tenantId);
  const provider = required(environment, sandboxHookEnvironment.agentProvider);
  const sessionRef = required(environment, sandboxHookEnvironment.agentSessionRef);
  if (runId === undefined || roleId === undefined || tenantId === undefined || provider === undefined || sessionRef === undefined) {
    return undefined;
  }
  return {
    toolUseId: input.tool_use_id,
    runId,
    roleId,
    tenantId,
    toolName: input.tool_name,
    input: input.tool_input,
    agentRef: { provider, sessionRef, isSubagent: typeof input.agent_id === "string" && input.agent_id.length > 0 },
  };
}

function responseResult(value: unknown, toolUseId: string): SandboxHookResult {
  if (!isRecord(value) || value.toolUseId !== toolUseId) return deny("broker.malformed_response");
  if (value.decision === "allow") {
    if (value.updatedInput !== undefined && !isRecord(value.updatedInput)) return deny("broker.malformed_response");
    return allow(value.updatedInput);
  }
  if (value.decision === "deny") return deny(typeof value.reason === "string" && value.reason.length > 0 ? value.reason : "broker.denied");
  return deny("broker.malformed_response");
}

function allow(updatedInput: unknown): SandboxHookResult {
  const output: Record<string, unknown> = { hookEventName: "PreToolUse", permissionDecision: "allow" };
  if (updatedInput !== undefined) output.updatedInput = updatedInput;
  return { exitCode: 0, stdout: `${JSON.stringify({ hookSpecificOutput: output })}\n`, stderr: "" };
}

function deny(reason: string): SandboxHookResult {
  return {
    exitCode: 2,
    stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } })}\n`,
    stderr: `${reason}\n`,
  };
}

function brokerEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${SANDBOX_BROKER_PATH}`;
}

function required(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = environment[name];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isBannedPermissionMode(value: unknown): boolean {
  return typeof value === "string" && new Set([["bypass", "Permissions"].join(""), ["accept", "Edits"].join("")]).has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === "AbortError";
}

async function main(): Promise<void> {
  // Claude Code only blocks code 2. Set this before parsing stdin or loading any input.
  process.exitCode = 2;
  installFailClosedProcessHandlers();
  let input: unknown;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    emit(deny("hook.malformed_input"));
    return;
  }
  emit(await runSandboxPreToolUseHook(input));
}

function emit(result: SandboxHookResult): void {
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main();
}

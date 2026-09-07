import { riskTiers, type RiskTier } from "@oikonomos/policy";
import type { SandboxClient, SandboxEndpoint } from "@oikonomos/sandbox-client";

/**
 * Sandbox-backed `GeminiTool` implementations (TASK-211).
 *
 * `createGeminiAdapter` (packages/harness-factory) decides nothing about
 * WHERE a tool runs — it calls `tool.execute()` and the caller supplies that
 * function. So the Gemini lane's isolation is entirely this module's choice,
 * and the lazy choice is dangerous: executing here, in the worker process,
 * would run model-directed commands on the control-plane host itself,
 * discarding the egress-controlled sandbox that TASK-185/208 built for the
 * Claude lane. Every executor below dispatches through execd into the role's
 * own sandbox, exactly as `executeSandboxChatRun` does.
 *
 * Ordering guarantee this module must not break: the adapter awaits
 * `l1.handle()` immediately before `execute()` (ADR-011 §2.2). Nothing here
 * may run, pre-warm, or otherwise side-effect before that decision returns —
 * construction is therefore inert, and the first I/O of any kind happens
 * inside `execute()`.
 */

/** Numeric tier the adapter compares against its own ceiling. */
export function tierNumber(tier: RiskTier): number {
  const index = riskTiers.indexOf(tier);
  if (index < 0) throw new Error(`Unknown risk tier: ${tier}`);
  return index;
}

/** Shape `createGeminiAdapter` requires, restated so this module need not import it. */
export interface SandboxGeminiTool {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: Record<string, unknown>;
  readonly tier: number;
  execute(arguments_: Record<string, unknown>): Promise<unknown>;
}

export interface SandboxToolContext {
  readonly client: SandboxClient;
  readonly endpoint: SandboxEndpoint;
  /** The role's durable in-sandbox workspace, as the Claude lane computes it. */
  readonly workspace: string;
  readonly timeoutMs?: number;
}

/** Matches the Claude lane's own per-command ceiling. */
export const SANDBOX_TOOL_TIMEOUT_MS = 10 * 60_000;

/**
 * Result handed back to the model for one tool call.
 *
 * A failed command is a RESULT, not an exception: a non-zero exit or an
 * unreachable sandbox must reach the model as something it can react to and
 * retry differently, not abort the whole run. Only a programming error
 * (a malformed argument) throws.
 */
export interface SandboxToolResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function requireStringArgument(arguments_: Record<string, unknown>, field: string): string {
  const value = arguments_[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Gemini tool argument '${field}' must be a non-empty string.`);
  }
  return value;
}

/**
 * Runs one command inside the role's sandbox.
 *
 * `envs` is deliberately empty: the Claude lane passes only a per-turn broker
 * identity and a model credential, and a tool call needs neither. Nothing of
 * the worker's own environment may reach a bot's tool process.
 */
async function runInSandbox(
  context: SandboxToolContext,
  command: string,
): Promise<SandboxToolResult> {
  try {
    const result = await context.client.runCommand(context.endpoint, {
      command,
      cwd: context.workspace,
      envs: {},
      timeoutMs: context.timeoutMs ?? SANDBOX_TOOL_TIMEOUT_MS,
    });
    return {
      ok: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  } catch (error) {
    // The sandbox being unreachable is a tool failure the model can be told
    // about, not a crashed run. The message is deliberately generic: a
    // transport error can carry endpoint/credential detail we must not put
    // in front of a model.
    return {
      ok: false,
      stdout: "",
      stderr: "The sandbox could not run this command.",
      exitCode: null,
    };
  }
}

/**
 * The governed tool surface for a Gemini run, tiered honestly.
 *
 * Tiers are the REAL ones from the capability registry — `runtime.bash` is
 * T3_external and `fs.read` is T0_observe — not flattened to 0 to slip past
 * the adapter's Stage-1 ceiling. Under `STAGE_ONE_MAXIMUM_TOOL_TIER = 0`
 * that means Read works and Bash is refused, which is the correct and
 * intended Stage-1 behaviour: TASK-212 lifts the ceiling deliberately, with
 * the per-provider cap and canary in place. Mislabelling Bash as Tier-0 here
 * would have quietly defeated exactly the control ADR-011 §3 put there.
 */
export function createSandboxGeminiTools(context: SandboxToolContext): readonly SandboxGeminiTool[] {
  return [
    {
      name: "Read",
      description: "Read a UTF-8 text file from the workspace.",
      parameters: {
        type: "object",
        properties: { file_path: { type: "string", description: "Path to read." } },
        required: ["file_path"],
      },
      tier: tierNumber("T0_observe"),
      execute: async (arguments_) =>
        runInSandbox(context, `cat -- ${shellQuote(requireStringArgument(arguments_, "file_path"))}`),
    },
    {
      name: "Bash",
      description: "Run a shell command in the workspace.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "Command to run." } },
        required: ["command"],
      },
      tier: tierNumber("T3_external"),
      execute: async (arguments_) => runInSandbox(context, requireStringArgument(arguments_, "command")),
    },
  ];
}

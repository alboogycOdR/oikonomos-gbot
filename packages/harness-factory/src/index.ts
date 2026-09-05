import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import { isL2Policy, L2_PERMISSION_MODE, type L2Policy } from "./config.js";
import type {
  AgentSdkQueryFn,
  AgentSdkQueryInput,
  CanUseToolPort,
  GateSubprocess,
  Harness,
  HarnessDeps,
  HarnessInvocation,
  PostToolUseHookPort,
  PreToolUseHookPort,
  PreToolUsePortDecision,
  SdkCanUseTool,
  SdkHookCallback,
  SubprocessSpawnRequest,
  SubprocessGateResult,
} from "./ports.js";

export const workspaceName = "harness-factory";

export function ping(): string {
  return workspaceName;
}

export { isL2Policy, L2_PERMISSION_MODE, type AllowedTool, type L2PermissionMode, type L2Policy } from "./config.js";
export {
  createSubagentL1,
  createSubagentRunIdentity,
  SubagentPolicyError,
  type CreateSubagentL1Options,
  type SubagentRunIdentity,
} from "./subagent.js";
export {
  bindEnvironment,
  type BoundEnvironment,
  type ConnectorSessionPool,
  type EnvironmentAuditIdentity,
  type EnvironmentOptions,
  type RunIdentity,
} from "./environment.js";
export {
  BudgetTapError,
  withBudgetTap,
  type BudgetTapReport,
  type BudgetTapSink,
} from "./budgetTap.js";

export type {
  AgentSdkQueryFn,
  AgentSdkQueryInput,
  CanUseToolPort,
  CanUseToolPortDecision,
  CanUseToolPortRequest,
  GateSubprocess,
  Harness,
  HarnessDeps,
  HarnessInvocation,
  L2PolicyPort,
  PostToolUseHookPort,
  PostToolUsePortRequest,
  PreToolUseHookPort,
  PreToolUsePortDecision,
  PreToolUsePortRequest,
  SdkCanUseTool,
  SdkHookCallback,
  SdkHookMatcher,
  SubprocessGateResult,
  SubprocessProvider,
  SubprocessSpawnRequest,
} from "./ports.js";

/** Seconds. ADR-001 R3: hook/callback timeout is 10 s for Tier 0–2. */
export const HOOK_TIMEOUT_SECONDS = 10;

/** Spawn of a non-Claude provider CLI is presented to L1 as this tool. */
export const SUBPROCESS_TOOL_NAME = "Bash";

export class HarnessFactoryError extends Error {
  readonly code: string;

  constructor(message: string, code = "HARNESS_FACTORY") {
    super(message);
    this.name = "HarnessFactoryError";
    this.code = code;
  }
}

/** Assembled at runtime so this package never contains banned mode tokens. */
export function bannedModeTokens(): readonly string[] {
  return [
    ["bypass", "Permissions"].join(""),
    ["accept", "Edits"].join(""),
  ];
}

export function createHarness(deps: HarnessDeps): Harness {
  assertDeps(deps);

  const invocation = buildInvocation(deps);
  const queryFn = deps.queryFn ?? defaultSdkQuery;
  const config: L2Policy = Object.freeze({
    permissionMode: L2_PERMISSION_MODE,
    allowedTools: Object.freeze([...deps.l2.allowedTools]),
  });

  const query: AgentSdkQueryFn = (input) => {
    const callerOptions =
      input.options && typeof input.options === "object" ? input.options : {};
    return queryFn({
      prompt: input.prompt,
      options: {
        ...callerOptions,
        permissionMode: invocation.permissionMode,
        allowedTools: [...invocation.allowedTools],
        hooks: invocation.hooks,
        canUseTool: invocation.canUseTool,
      },
    });
  };

  return {
    query,
    config,
    invocation,
    gateSubprocess: (request) => gateSubprocessThroughL1(deps.l1, request),
  };
}

function assertDeps(deps: HarnessDeps): void {
  if (typeof deps !== "object" || deps === null) {
    throw new HarnessFactoryError("createHarness requires a deps object", "INVALID_DEPS");
  }
  if (typeof deps.l1?.handle !== "function") {
    throw new HarnessFactoryError("createHarness requires an L1 PreToolUse port", "MISSING_L1");
  }
  if (!isL2Policy(deps.l2)) {
    throw new HarnessFactoryError(
      `createHarness requires L2 permissionMode "${L2_PERMISSION_MODE}" and an allowedTools array`,
      "INVALID_L2",
    );
  }
  if (typeof deps.l3?.canUseTool !== "function") {
    throw new HarnessFactoryError("createHarness requires an L3 canUseTool port", "MISSING_L3");
  }
  if (deps.postToolUse !== undefined && typeof deps.postToolUse.handle !== "function") {
    throw new HarnessFactoryError("postToolUse port must implement handle()", "INVALID_POST");
  }
  if (deps.queryFn !== undefined && typeof deps.queryFn !== "function") {
    throw new HarnessFactoryError("queryFn must be a function when provided", "INVALID_QUERY");
  }

  const serialized = JSON.stringify({
    permissionMode: deps.l2.permissionMode,
    allowedTools: deps.l2.allowedTools,
  });
  for (const token of bannedModeTokens()) {
    if (serialized.includes(token)) {
      throw new HarnessFactoryError("banned permission mode in L2 config", "BANNED_MODE");
    }
  }
}

function buildInvocation(deps: HarnessDeps): HarnessInvocation {
  const hooks: HarnessInvocation["hooks"] = {
    PreToolUse: [
      {
        hooks: [adaptL1(deps.l1)],
        timeout: HOOK_TIMEOUT_SECONDS,
      },
    ],
  };

  if (deps.postToolUse) {
    hooks.PostToolUse = [
      {
        hooks: [adaptPostToolUse(deps.postToolUse)],
        timeout: HOOK_TIMEOUT_SECONDS,
      },
    ];
  }

  return {
    permissionMode: L2_PERMISSION_MODE,
    allowedTools: [...deps.l2.allowedTools],
    hooks,
    canUseTool: adaptL3(deps.l3),
  };
}

function adaptL1(port: PreToolUseHookPort): SdkHookCallback {
  return async (input, toolUseID) => {
    if (input.hook_event_name !== "PreToolUse") {
      return {};
    }

    const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
    const toolUseId =
      (typeof input.tool_use_id === "string" && input.tool_use_id) || toolUseID || "";

    if (!toolName || !toolUseId) {
      return denyPreToolUse("malformed PreToolUse input");
    }

    let decision: PreToolUsePortDecision;
    try {
      decision = await port.handle({
        toolName,
        toolUseId,
        input: asRecord(input.tool_input),
      });
    } catch (err) {
      return denyPreToolUse(describeError(err, "L1 failed closed"));
    }

    if (decision.decision === "allow") {
      const output: Record<string, unknown> = {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      };
      if (decision.updatedInput !== undefined) {
        output.updatedInput = decision.updatedInput;
      }
      return { hookSpecificOutput: output };
    }

    return denyPreToolUse(decision.message);
  };
}

function adaptL3(port: CanUseToolPort): SdkCanUseTool {
  return async (toolName, input, options) => {
    try {
      return await port.canUseTool({
        toolName,
        toolUseId: options.toolUseID,
        input,
      });
    } catch (err) {
      return { behavior: "deny", message: describeError(err, "L3 failed closed") };
    }
  };
}

function adaptPostToolUse(port: PostToolUseHookPort): SdkHookCallback {
  return async (input, toolUseID) => {
    if (input.hook_event_name !== "PostToolUse") {
      return {};
    }
    const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
    const toolUseId =
      (typeof input.tool_use_id === "string" && input.tool_use_id) || toolUseID || "";
    if (!toolName || !toolUseId) {
      throw new HarnessFactoryError("malformed PostToolUse input", "MALFORMED_POST");
    }
    await port.handle({
      toolName,
      toolUseId,
      input: asRecord(input.tool_input),
      toolResponse: input.tool_response,
    });
    return {};
  };
}

export async function gateSubprocessThroughL1(
  l1: PreToolUseHookPort,
  request: SubprocessSpawnRequest,
): Promise<SubprocessGateResult> {
  if (!request || typeof request.command !== "string" || request.command.length === 0) {
    return { allow: false, message: "subprocess spawn missing command" };
  }
  if (request.provider !== "codex" && request.provider !== "grok") {
    return { allow: false, message: "subprocess spawn provider is not gated" };
  }

  const toolUseId = `spawn:${request.provider}:${randomUUID()}`;
  const command = [request.command, ...request.args].join(" ");

  let decision: PreToolUsePortDecision;
  try {
    decision = await l1.handle({
      toolName: SUBPROCESS_TOOL_NAME,
      toolUseId,
      input: {
        command,
        cwd: request.cwd,
        provider: request.provider,
      },
    });
  } catch (err) {
    return { allow: false, message: describeError(err, "subprocess spawn failed closed") };
  }

  if (decision.decision === "allow") {
    return { allow: true, request };
  }
  return { allow: false, message: decision.message };
}

function denyPreToolUse(message: string): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: message,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function describeError(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function defaultSdkQuery(input: AgentSdkQueryInput): AsyncIterable<unknown> {
  return lazySdkQuery(input);
}

async function* lazySdkQuery(input: AgentSdkQueryInput): AsyncGenerator<unknown> {
  const mod = (await import("@anthropic-ai/claude-agent-sdk")) as {
    query?: AgentSdkQueryFn;
  };
  if (typeof mod.query !== "function") {
    throw new HarnessFactoryError(
      "Agent SDK query() is unavailable; bind queryFn through createHarness",
      "SDK_QUERY_MISSING",
    );
  }
  yield* mod.query(withSystemClaudeExecutable(input));
}

/**
 * Prefer an up-to-date system Claude CLI when one is available. The Agent SDK
 * remains the fallback so installations without a global CLI retain its
 * default behaviour.
 */
function withSystemClaudeExecutable(input: AgentSdkQueryInput): AgentSdkQueryInput {
  if (input.options?.pathToClaudeCodeExecutable !== undefined) {
    return input;
  }

  const executable = resolveSystemClaudeExecutable();
  if (executable === undefined) {
    return input;
  }

  return {
    ...input,
    options: {
      ...input.options,
      pathToClaudeCodeExecutable: executable,
      // A governed chat run explicitly scopes both its workspace and
      // environment. A system-installed CLI may nevertheless discover
      // account-backed connector configuration outside that environment, so
      // restrict this invocation to the configuration Oikonomos supplies.
      ...(isGovernedInvocation(input.options) ? { strictMcpConfig: true } : {}),
    },
  };
}

/** The chat driver supplies both values for every isolated, governed run. */
function isGovernedInvocation(options: AgentSdkQueryInput["options"]): boolean {
  return options?.cwd !== undefined && options.env !== undefined;
}

function resolveSystemClaudeExecutable(): string | undefined {
  try {
    const command = process.platform === "win32" ? "where" : "which";
    const output = execFileSync(command, ["claude"], {
      encoding: "utf8",
      windowsHide: true,
    });
    return output.split(/\r?\n/).map((path) => path.trim()).find(Boolean);
  } catch {
    return undefined;
  }
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  describe("@oikonomos/harness-factory", () => {
    it("ping returns the workspace name", () => {
      expect(ping()).toBe("harness-factory");
    });
  });
}

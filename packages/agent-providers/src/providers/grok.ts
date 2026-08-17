import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AgentProvider, ProviderCapabilities, ProviderEvent, SendPromptOptions } from "../types.js";

export type GrokSandboxProfile = "workspace" | "read-only" | "strict" | "devbox" | "off";

export interface GrokProviderOptions {
  bin: string;
  defaultModel: string;
  sandbox: GrokSandboxProfile;
  /**
   * Headless runs have no TTY to answer an interactive approval prompt, so
   * unlike Claude Code's canUseTool flow there is nothing to route to a
   * Telegram button. Setting this passes `--always-approve` so a turn that
   * needs to write files or run commands doesn't stall forever waiting for
   * an approval channel that doesn't exist in headless mode; the `sandbox`
   * profile is then the real safety boundary, same as the Codex provider.
   */
  alwaysApprove: boolean;
  apiKey?: string;
}

const AVAILABLE_MODELS = ["grok-4.5", "grok-build-0.1"] as const;

/**
 * Pure arg-builder, extracted so the CLI invocation can be unit tested
 * without spawning a real subprocess. Mirrors the flags documented at
 * https://docs.x.ai/build/cli/headless-scripting and
 * https://docs.x.ai/build/cli/reference.
 */
export function buildGrokArgs(
  opts: Pick<SendPromptOptions, "prompt" | "cwd" | "model" | "sessionId">,
  config: { defaultModel: string; sandbox: GrokSandboxProfile; alwaysApprove: boolean },
  newSessionId: string,
): string[] {
  const args = [
    "-p",
    opts.prompt,
    "--cwd",
    opts.cwd,
    "--output-format",
    "plain",
    "--no-alt-screen",
    "--no-auto-update",
    "--sandbox",
    config.sandbox,
    "-m",
    opts.model ?? config.defaultModel,
  ];

  if (config.alwaysApprove) {
    args.push("--always-approve");
  }

  if (opts.sessionId) {
    args.push("-r", opts.sessionId);
  } else {
    args.push("-s", newSessionId);
  }

  return args;
}

/**
 * xAI's Grok Build CLI (binary name `grok`), run non-interactively via
 * `grok -p "<prompt>" --output-format plain`. Grok Build publishes a
 * `streaming-json` output mode, but as of this writing xAI's docs describe
 * it only as "newline-delimited JSON events" without documenting the event
 * schema field-by-field (unlike Codex's `item_type` list). Rather than
 * guess at undocumented field names, this adapter uses `plain` output and
 * relays raw stdout chunks as they arrive as `text_delta` events — real
 * streaming, just without structured tool-call visibility. If xAI
 * publishes the streaming-json schema, swap the output format and add a
 * line parser the same way `providers/codex.ts` does.
 */
export class GrokProvider implements AgentProvider {
  readonly id = "grok" as const;
  readonly displayName = "Grok Build";
  readonly defaultModel: string;
  readonly availableModels = AVAILABLE_MODELS;
  readonly capabilities: ProviderCapabilities = {
    agentic: true,
    resumableSessions: true,
    permissionPrompts: false,
    interruptible: true,
  };

  private readonly bin: string;
  private readonly sandbox: GrokSandboxProfile;
  private readonly alwaysApprove: boolean;
  private readonly apiKey: string | undefined;
  private activeChild: ChildProcessWithoutNullStreams | null = null;

  constructor(options: GrokProviderOptions) {
    this.bin = options.bin;
    this.defaultModel = options.defaultModel;
    this.sandbox = options.sandbox;
    this.alwaysApprove = options.alwaysApprove;
    this.apiKey = options.apiKey;
  }

  async interrupt(): Promise<void> {
    this.activeChild?.kill("SIGTERM");
  }

  async *sendPrompt(opts: SendPromptOptions): AsyncGenerator<ProviderEvent, void, unknown> {
    // Grok Build's `-s/--session-id` sets the ID for a *new* session rather
    // than returning one after the fact, so we mint it ourselves up front —
    // this also means we know the session id even if the process is killed
    // mid-turn, with no output-parsing required to recover it.
    const sessionId = opts.sessionId ?? randomUUID();
    const args = buildGrokArgs(
      opts,
      { defaultModel: this.defaultModel, sandbox: this.sandbox, alwaysApprove: this.alwaysApprove },
      sessionId,
    );

    const env = { ...process.env };
    if (this.apiKey) env.XAI_API_KEY = this.apiKey;

    const isWin = process.platform === "win32";
    const child = spawn(this.bin, args, {
      cwd: opts.cwd,
      env,
      shell: isWin,
      windowsHide: true,
    });
    this.activeChild = child;

    const onAbort = () => child.kill("SIGTERM");
    opts.signal.addEventListener("abort", onAbort);

    const stderrChunks: string[] = [];
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk.toString("utf-8"));
      if (stderrChunks.length > 200) stderrChunks.shift();
    });

    let sawAnyOutput = false;

    try {
      for await (const chunk of child.stdout) {
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
        if (text.length === 0) continue;
        sawAnyOutput = true;
        yield { type: "text_delta", text };
      }

      const exitCode: number = await new Promise((resolve) => {
        child.once("close", (code) => resolve(code ?? -1));
      });

      if (opts.signal.aborted) {
        yield { type: "error", message: "Interrupted by user.", fatal: false };
        return;
      }

      if (exitCode !== 0) {
        const tail = stderrChunks.join("").slice(-800).trim();
        yield {
          type: "error",
          fatal: true,
          message: `Grok Build exited with code ${exitCode}.${tail ? ` stderr: ${tail}` : ""}`,
        };
        return;
      }

      if (!sawAnyOutput) {
        yield { type: "error", fatal: true, message: "Grok Build returned an empty response." };
        return;
      }

      yield { type: "turn_complete", sessionId, costUsd: null, durationMs: null, turns: 1 };
    } finally {
      opts.signal.removeEventListener("abort", onAbort);
      this.activeChild = null;
    }
  }
}

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentProvider, ProviderCapabilities, ProviderEvent, SendPromptOptions } from "../types.js";

/** Structural seam compatible with harness-factory's GateSubprocess port. */
export interface SubprocessSpawnRequest {
  provider: "codex" | "grok";
  command: string;
  args: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string | undefined>>;
}

export type GateSpawn = (request: SubprocessSpawnRequest) => Promise<{ allow: boolean; message?: string }>;

export interface CodexProviderOptions {
  bin: string;
  defaultModel: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  apiKey?: string;
  /** Broker-backed gate. Every CLI spawn must receive an allow decision. */
  gateSpawn?: GateSpawn;
}

const AVAILABLE_MODELS = ["gpt-5.4", "gpt-5.4-mini", "gpt-5-codex"] as const;

/**
 * Codex event schema (from `codex exec --json`), documented at
 * https://developers.openai.com/codex/noninteractive
 *
 * We type only the fields we rely on and treat everything else as unknown so
 * a future Codex release adding fields (or item types) degrades gracefully
 * instead of throwing.
 */
interface CodexThreadStarted {
  type: "thread.started";
  thread_id: string;
}
interface CodexTurnStarted {
  type: "turn.started";
}
interface CodexTurnCompleted {
  type: "turn.completed";
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
}
interface CodexTurnFailed {
  type: "turn.failed";
  error?: { message?: string };
}
interface CodexItemEvent {
  type: "item.started" | "item.updated" | "item.completed";
  item: {
    id: string;
    item_type: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number | null;
    status?: string;
    [key: string]: unknown;
  };
}
type CodexEvent = CodexThreadStarted | CodexTurnStarted | CodexTurnCompleted | CodexTurnFailed | CodexItemEvent;

export function isCodexEvent(value: unknown): value is CodexEvent {
  return typeof value === "object" && value !== null && "type" in value && typeof (value as { type: unknown }).type === "string";
}

/**
 * Pure mapping from one parsed Codex JSONL event to zero or more
 * ProviderEvents. Extracted as a standalone function (rather than a private
 * method) so it can be unit tested directly against the documented Codex
 * event shapes without spawning a real subprocess.
 */
export function mapCodexEvent(event: CodexEvent, openToolItems: Map<string, string>): ProviderEvent[] {
  if (event.type === "item.completed" && event.item.item_type === "assistant_message") {
    const text = event.item.text ?? "";
    return text.length > 0 ? [{ type: "text_delta", text }] : [];
  }

  if (event.type === "item.completed" && event.item.item_type === "reasoning") {
    const text = event.item.text ?? "";
    return text.length > 0 ? [{ type: "thinking_delta", text }] : [];
  }

  if (event.type === "item.started" && event.item.item_type === "command_execution") {
    openToolItems.set(event.item.id, "command_execution");
    const command = event.item.command ?? "";
    return [
      {
        type: "tool_start",
        toolName: "bash",
        toolUseId: event.item.id,
        summary: command.length > 120 ? command.slice(0, 117) + "..." : command,
      },
    ];
  }

  if (event.type === "item.completed" && event.item.item_type === "command_execution") {
    openToolItems.delete(event.item.id);
    const output = (event.item.aggregated_output ?? "").trim();
    const ok = (event.item.exit_code ?? 1) === 0;
    return [
      {
        type: "tool_end",
        toolUseId: event.item.id,
        ok,
        summary: output.length > 200 ? output.slice(0, 197) + "..." : output || "(no output)",
      },
    ];
  }

  if (event.type === "item.started" && event.item.item_type === "file_change") {
    openToolItems.set(event.item.id, "file_change");
    return [{ type: "tool_start", toolName: "file_change", toolUseId: event.item.id, summary: "Editing files..." }];
  }

  if (event.type === "item.completed" && event.item.item_type === "file_change") {
    openToolItems.delete(event.item.id);
    return [{ type: "tool_end", toolUseId: event.item.id, ok: true, summary: "File changes applied." }];
  }

  if (event.type === "item.started" && event.item.item_type === "mcp_tool_call") {
    openToolItems.set(event.item.id, "mcp_tool_call");
    return [{ type: "tool_start", toolName: "mcp_tool_call", toolUseId: event.item.id, summary: "Calling MCP tool..." }];
  }

  if (event.type === "item.completed" && event.item.item_type === "mcp_tool_call") {
    openToolItems.delete(event.item.id);
    return [{ type: "tool_end", toolUseId: event.item.id, ok: true, summary: "MCP tool call finished." }];
  }

  if (event.type === "item.completed" && event.item.item_type === "web_search") {
    return [
      { type: "tool_start", toolName: "web_search", toolUseId: event.item.id, summary: "Searching the web..." },
      { type: "tool_end", toolUseId: event.item.id, ok: true, summary: "Search complete." },
    ];
  }

  return [];
}

/**
 * Full agentic coding via the OpenAI `codex` CLI, run non-interactively
 * (`codex exec --json`) as a subprocess per turn. Codex's non-interactive
 * mode never prompts for approval — safety is entirely governed by the
 * `--sandbox` flag — so this provider does not support permission prompts;
 * choose `CODEX_SANDBOX=read-only` for a look-but-don't-touch mode.
 */
export class CodexProvider implements AgentProvider {
  readonly id = "codex" as const;
  readonly displayName = "Codex CLI";
  readonly defaultModel: string;
  readonly availableModels = AVAILABLE_MODELS;
  readonly capabilities: ProviderCapabilities = {
    agentic: true,
    resumableSessions: true,
    permissionPrompts: false,
    interruptible: true,
  };

  private readonly bin: string;
  private readonly sandbox: CodexProviderOptions["sandbox"];
  private readonly apiKey: string | undefined;
  private readonly gateSpawn: GateSpawn | undefined;
  private activeChild: ChildProcessWithoutNullStreams | null = null;

  constructor(options: CodexProviderOptions) {
    this.bin = options.bin;
    this.defaultModel = options.defaultModel;
    this.sandbox = options.sandbox;
    this.apiKey = options.apiKey;
    this.gateSpawn = options.gateSpawn;
  }

  async interrupt(): Promise<void> {
    this.activeChild?.kill("SIGTERM");
  }

  async *sendPrompt(opts: SendPromptOptions): AsyncGenerator<ProviderEvent, void, unknown> {
    const args = this.buildArgs(opts);
    const env = { ...process.env };
    if (this.apiKey) env.CODEX_API_KEY = this.apiKey;

    const request: SubprocessSpawnRequest = { provider: this.id, command: this.bin, args, cwd: opts.cwd, env };
    let gateResult: { allow: boolean; message?: string } | undefined;
    if (!this.gateSpawn) {
      yield { type: "error", fatal: true, message: "Codex spawn denied: broker gate is not configured." };
      return;
    }
    try {
      gateResult = await this.gateSpawn(request);
    } catch (err) {
      const detail = err instanceof Error && err.message ? `: ${err.message}` : "";
      yield { type: "error", fatal: true, message: `Codex spawn denied: broker gate failed closed${detail}` };
      return;
    }
    if (gateResult?.allow !== true) {
      yield { type: "error", fatal: true, message: `Codex spawn denied: ${gateResult?.message ?? "broker denied request"}` };
      return;
    }

    const child = spawn(this.bin, args, { cwd: opts.cwd, env, windowsHide: true });
    this.activeChild = child;

    const onAbort = () => child.kill("SIGTERM");
    opts.signal.addEventListener("abort", onAbort);

    const stderrChunks: string[] = [];
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk.toString("utf-8"));
      if (stderrChunks.length > 200) stderrChunks.shift();
    });

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

    let threadId: string | null = opts.sessionId;
    let turnFailedMessage: string | null = null;
    let sawTurnCompleted = false;
    const openToolItems = new Map<string, string>();

    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (!isCodexEvent(parsed)) continue;

        for (const evt of mapCodexEvent(parsed, openToolItems)) {
          yield evt;
        }

        if (parsed.type === "thread.started") {
          threadId = parsed.thread_id;
        } else if (parsed.type === "turn.completed") {
          sawTurnCompleted = true;
        } else if (parsed.type === "turn.failed") {
          turnFailedMessage = parsed.error?.message ?? "Codex turn failed with no error detail.";
        }
      }

      const exitCode: number = await new Promise((resolve) => {
        child.once("close", (code) => resolve(code ?? -1));
      });

      if (turnFailedMessage) {
        yield { type: "error", message: turnFailedMessage, fatal: true };
      } else if (!sawTurnCompleted) {
        const tail = stderrChunks.join("").slice(-800).trim();
        if (opts.signal.aborted) {
          yield { type: "error", message: "Interrupted by user.", fatal: false };
        } else {
          yield {
            type: "error",
            message: `Codex exited (code ${exitCode}) without completing a turn.${tail ? ` stderr: ${tail}` : ""}`,
            fatal: true,
          };
        }
      } else {
        yield { type: "turn_complete", sessionId: threadId, costUsd: null, durationMs: null, turns: 1 };
      }
    } finally {
      opts.signal.removeEventListener("abort", onAbort);
      this.activeChild = null;
    }
  }

  private buildArgs(opts: SendPromptOptions): string[] {
    const args = ["exec", "-C", opts.cwd, "--skip-git-repo-check", "--json", "--sandbox", this.sandbox];

    if (opts.model) {
      args.push("--model", opts.model);
    } else {
      args.push("--model", this.defaultModel);
    }

    if (opts.sessionId) {
      args.push("resume", opts.sessionId, opts.prompt);
    } else {
      args.push(opts.prompt);
    }

    return args;
  }
}

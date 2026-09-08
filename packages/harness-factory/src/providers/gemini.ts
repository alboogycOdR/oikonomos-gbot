/**
 * Gemini's function-calling API leaves tool execution to its caller. This
 * loop is therefore the provider's ADR-001 enforcement point: each function
 * call is submitted to L1 before it can execute or be returned to Gemini.
 */

import { randomUUID } from "node:crypto";

import type { PreToolUseHookPort } from "../ports.js";

export const GEMINI_GENERATE_CONTENT_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent";
export const GEMINI_REQUEST_TIMEOUT_MS = 10_000;
/** Stage 1's ceiling. Stage 2 changes this one named policy constant. */
export const STAGE_ONE_MAXIMUM_TOOL_TIER = 0;

/**
 * Stage 2's ceiling: T2_internal (TASK-212).
 *
 * ADR-011 §3 leaves Stage 2 as "full tool-executing parity" without naming a
 * tier, and §7 then constrained it — after the R30,000 → R350 reset,
 * `gemini-3.7-flash` must not become an uncapped default for tool-executing
 * runs. Two things follow, and they point at T2 rather than at parity:
 *
 * 1. T3_external and T4_irreversible are precisely the tiers that require an
 *    operator approval before they run. Extending them to the cheapest model
 *    in the fleet is a materially different decision from "let Gemini use
 *    tools", and it is not one ADR-011 actually took. It needs its own.
 * 2. T2 is enough for the product this unblocks: the browser lane's tools are
 *    `browser.navigate` (T1) and `browser.interact` (T2). Capping at T2 buys
 *    the whole browsing capability while leaving the irreversible tiers where
 *    they were.
 *
 * The tier check is defence in depth, NOT the gate — the broker's decision is
 * the authority, and it still runs first. This ceiling exists so that a
 * broker misconfiguration cannot hand the cheapest model an irreversible
 * external action.
 */
export const STAGE_TWO_MAXIMUM_TOOL_TIER = 2;

/**
 * Highest tier this adapter will accept as a configured ceiling, ever.
 *
 * A LITERAL, deliberately not derived from {@link STAGE_TWO_MAXIMUM_TOOL_TIER}
 * (Fable review of `81be2aa`). Aliasing the two expressed the wrong intent:
 * raising the Stage-2 ceiling later would silently raise the absolute bound
 * with it, so the backstop would move whenever the thing it is supposed to
 * backstop moved. They answer different questions — "what does this stage
 * allow" versus "what may this adapter ever be configured to allow" — and
 * only the second is a security boundary. The guard test below fails if they
 * are ever collapsed back together.
 */
const ABSOLUTE_MAXIMUM_TOOL_TIER = 2;

export interface GeminiFunctionDeclaration {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: Record<string, unknown>;
}

export interface GeminiTool extends GeminiFunctionDeclaration {
  /** Tier assigned by the application, never trusted from the model. */
  readonly tier: number;
  execute(arguments_: Record<string, unknown>): Promise<unknown>;
}

export interface GeminiAdapterOptions {
  readonly l1: PreToolUseHookPort;
  readonly tools?: readonly GeminiTool[];
  /**
   * Highest tool tier this run may execute. Defaults to
   * {@link STAGE_ONE_MAXIMUM_TOOL_TIER} so every existing caller keeps its
   * current behaviour; the Stage-2 wiring passes
   * {@link STAGE_TWO_MAXIMUM_TOOL_TIER} explicitly. Values above
   * {@link STAGE_TWO_MAXIMUM_TOOL_TIER} are refused at construction rather
   * than honoured — an adapter that accepted "5" would silently permit
   * irreversible external actions on the cheapest model in the fleet.
   */
  readonly maximumToolTier?: number;
  /** Test transport seam; production defaults to Node 22's native fetch. */
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export interface GeminiFunctionResponse {
  readonly name: string;
  readonly response: Record<string, unknown>;
}

/**
 * Token usage, summed across every real API call this run made.
 *
 * A tool-executing turn is one CONVERSATION but several HTTP calls — the
 * loop below resubmits the growing `contents` array once per function-call
 * round trip, and each one is a separately billed request. Gemini's own
 * `usageMetadata` reports only that single call's counts, so the caller
 * (`geminiTurnCostUsd`) needs the sum across the whole run, not just the
 * final call's figure — summing per-call totals is correct because each
 * call really was billed independently.
 */
export interface GeminiUsage {
  readonly promptTokenCount: number;
  readonly candidatesTokenCount: number;
  readonly thoughtsTokenCount: number;
  readonly totalTokenCount: number;
}

const ZERO_USAGE: GeminiUsage = { promptTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 0, totalTokenCount: 0 };

function addUsage(a: GeminiUsage, b: GeminiUsage): GeminiUsage {
  return {
    promptTokenCount: a.promptTokenCount + b.promptTokenCount,
    candidatesTokenCount: a.candidatesTokenCount + b.candidatesTokenCount,
    thoughtsTokenCount: a.thoughtsTokenCount + b.thoughtsTokenCount,
    totalTokenCount: a.totalTokenCount + b.totalTokenCount,
  };
}

function usageFrom(value: unknown): GeminiUsage {
  if (!isRecord(value) || !isRecord(value.usageMetadata)) return ZERO_USAGE;
  const m = value.usageMetadata;
  return {
    promptTokenCount: nonNegativeInteger(m.promptTokenCount),
    candidatesTokenCount: nonNegativeInteger(m.candidatesTokenCount),
    thoughtsTokenCount: nonNegativeInteger(m.thoughtsTokenCount),
    totalTokenCount: nonNegativeInteger(m.totalTokenCount),
  };
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export interface GeminiRunResult {
  readonly text: string;
  readonly functionResponses: readonly GeminiFunctionResponse[];
  readonly denied: boolean;
  /** Summed across every real API call this run made; all-zero if none were. */
  readonly usage: GeminiUsage;
}

/**
 * Constructing the adapter is the only time its credential is read. The key
 * is held in this closure only long enough to authenticate requests; no log
 * or telemetry dependency is accepted by this module.
 */
export function createGeminiAdapter(options: GeminiAdapterOptions): {
  run(prompt: string): Promise<GeminiRunResult>;
} {
  assertOptions(options);
  const apiKey = process.env.GEMINI_API_KEY;
  const toolByName = new Map(options.tools?.map((tool) => [tool.name, tool]) ?? []);
  const fetchFn = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? GEMINI_REQUEST_TIMEOUT_MS;
  const maximumToolTier = options.maximumToolTier ?? STAGE_ONE_MAXIMUM_TOOL_TIER;

  return {
    async run(prompt: string): Promise<GeminiRunResult> {
      if (typeof prompt !== "string" || prompt.length === 0) {
        return deniedResult("Gemini prompt is required");
      }
      if (typeof apiKey !== "string" || apiKey.length === 0) {
        return deniedResult("Gemini API key is unavailable");
      }

      const contents: Array<Record<string, unknown>> = [
        { role: "user", parts: [{ text: prompt }] },
      ];
      const functionResponses: GeminiFunctionResponse[] = [];
      let usage = ZERO_USAGE;

      for (let turn = 0; turn < 12; turn += 1) {
        const response = await requestGemini(fetchFn, apiKey, contents, options.tools ?? [], timeoutMs);
        // A real call was made either way (a deny here means the response
        // was unusable, e.g. a non-2xx or a malformed body — never that no
        // request happened), so its usage — likely ZERO_USAGE, since a
        // denied call rarely parses a usageMetadata block, but reported
        // honestly either way — is still folded in.
        usage = addUsage(usage, response.usage);
        if (response.kind === "deny") {
          return { text: "", functionResponses, denied: true, usage };
        }

        const functionCalls = functionCallsFrom(response.content);
        if (functionCalls.length === 0) {
          return { text: textFrom(response.content), functionResponses, denied: false, usage };
        }

        const responseParts: Array<Record<string, unknown>> = [];
        for (const call of functionCalls) {
          // This await is deliberately adjacent to execution: ADR-011 §2.2.
          const decision = await decideFunctionCall(options.l1, call, toolByName, maximumToolTier);
          const functionResponse = await functionResponseFor(call, decision, toolByName);
          functionResponses.push(functionResponse);
          responseParts.push({ functionResponse });
        }

        contents.push(response.content, { role: "user", parts: responseParts });
      }

      return { text: "", functionResponses, denied: true, usage };
    },
  };
}

async function decideFunctionCall(
  l1: PreToolUseHookPort,
  call: GeminiFunctionCall,
  toolByName: ReadonlyMap<string, GeminiTool>,
  maximumToolTier: number,
): Promise<{ allow: true; input: Record<string, unknown> } | { allow: false; message: string }> {
  // Structural checks run BEFORE the broker, and only ever deny.
  //
  // Ordering finding, Fable review of 81be2aa: with the broker first, a T3
  // call could consume a NONCE-BOUND, SINGLE-USE operator approval
  // (CLAUDE.md non-negotiable 8) and then be refused locally — burning the
  // operator's approval on an action that never ran, with the refusal
  // recorded nowhere the broker can see. A pre-filter that can only ever
  // deny cannot make anything more permissive, so putting it first costs no
  // authority: the broker still decides everything that survives it, and
  // remains the single source of allow.
  const tool = toolByName.get(call.name);
  if (tool === undefined) {
    return { allow: false, message: "Gemini requested an unknown tool" };
  }
  // Bounded maximum, not an equality test: a tool at or below the ceiling
  // runs, anything above it is refused. Equality also refused a HIGHER
  // ceiling's lower-tier tools, which made the constant impossible to raise
  // without changing its meaning.
  if (!Number.isInteger(tool.tier) || tool.tier < 0 || tool.tier > maximumToolTier) {
    return {
      allow: false,
      message: `Gemini permits tools at tier ${maximumToolTier} or below; this tool is tier ${String(tool.tier)}`,
    };
  }

  let decision;
  try {
    decision = await l1.handle({
      toolName: call.name,
      toolUseId: `gemini:${randomUUID()}`,
      input: call.arguments,
    });
  } catch {
    return { allow: false, message: "Gemini tool request denied: broker unavailable" };
  }
  if (decision.decision === "deny") {
    return { allow: false, message: decision.message };
  }

  return { allow: true, input: decision.updatedInput ?? call.arguments };
}

async function functionResponseFor(
  call: GeminiFunctionCall,
  decision: { allow: true; input: Record<string, unknown> } | { allow: false; message: string },
  toolByName: ReadonlyMap<string, GeminiTool>,
): Promise<GeminiFunctionResponse> {
  if (!decision.allow) {
    return { name: call.name, response: { error: decision.message } };
  }

  try {
    const result = await toolByName.get(call.name)!.execute(decision.input);
    return { name: call.name, response: { result } };
  } catch {
    return { name: call.name, response: { error: "Gemini tool execution failed" } };
  }
}

type GeminiResponse =
  | { kind: "content"; content: Record<string, unknown>; usage: GeminiUsage }
  | { kind: "deny"; usage: GeminiUsage };

async function requestGemini(
  fetchFn: typeof globalThis.fetch,
  apiKey: string,
  contents: readonly Record<string, unknown>[],
  tools: readonly GeminiTool[],
  timeoutMs: number,
): Promise<GeminiResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(`${GEMINI_GENERATE_CONTENT_URL}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents,
        tools: tools.length === 0
          ? undefined
          : [{ functionDeclarations: tools.map(({ name, description, parameters }) => ({ name, description, parameters })) }],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { kind: "deny", usage: ZERO_USAGE };
    }
    const parsed: unknown = await response.json();
    const usage = usageFrom(parsed);
    const content = contentFrom(parsed);
    return content === undefined ? { kind: "deny", usage } : { kind: "content", content, usage };
  } catch {
    return { kind: "deny", usage: ZERO_USAGE };
  } finally {
    clearTimeout(timer);
  }
}

interface GeminiFunctionCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

function contentFrom(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !Array.isArray(value.candidates) || value.candidates.length === 0) {
    return undefined;
  }
  const candidate = value.candidates[0];
  if (!isRecord(candidate) || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) {
    return undefined;
  }
  return candidate.content;
}

function functionCallsFrom(content: Record<string, unknown>): GeminiFunctionCall[] {
  if (!Array.isArray(content.parts)) {
    return [];
  }
  return content.parts.flatMap((part): GeminiFunctionCall[] => {
    if (!isRecord(part) || !isRecord(part.functionCall)) {
      return [];
    }
    const { name, args } = part.functionCall;
    return typeof name === "string" && name.length > 0 && (args === undefined || isRecord(args))
      ? [{ name, arguments: args ?? {} }]
      : [];
  });
}

function textFrom(content: Record<string, unknown>): string {
  if (!Array.isArray(content.parts)) {
    return "";
  }
  return content.parts
    .filter(isRecord)
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("");
}

function deniedResult(message: string): GeminiRunResult {
  return {
    text: "",
    functionResponses: [{ name: "gemini", response: { error: message } }],
    denied: true,
    usage: ZERO_USAGE,
  };
}

function assertOptions(options: GeminiAdapterOptions): void {
  if (typeof options?.l1?.handle !== "function") {
    throw new Error("Gemini adapter requires an L1 PreToolUse port");
  }
  if (options.fetch !== undefined && typeof options.fetch !== "function") {
    throw new Error("Gemini adapter fetch must be a function");
  }
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error("Gemini adapter timeoutMs must be positive");
  }
  // Refused at construction, not clamped: silently lowering a ceiling an
  // operator asked for would hide a misconfiguration, and silently honouring
  // one above T2 would hand irreversible external actions to the cheapest
  // model in the fleet. Raising this bound is a deliberate ADR decision, not
  // a config change.
  if (options.maximumToolTier !== undefined) {
    if (
      !Number.isInteger(options.maximumToolTier) ||
      options.maximumToolTier < 0 ||
      options.maximumToolTier > ABSOLUTE_MAXIMUM_TOOL_TIER
    ) {
      throw new Error(
        `Gemini adapter maximumToolTier must be an integer between 0 and ${ABSOLUTE_MAXIMUM_TOOL_TIER}`,
      );
    }
  }
  for (const tool of options.tools ?? []) {
    if (
      !tool ||
      typeof tool.name !== "string" ||
      tool.name.length === 0 ||
      !Number.isInteger(tool.tier) ||
      tool.tier < 0 ||
      typeof tool.execute !== "function"
    ) {
      throw new Error("Gemini adapter tools require a name and execute function");
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  /** Test transport seam; production defaults to Node 22's native fetch. */
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export interface GeminiFunctionResponse {
  readonly name: string;
  readonly response: Record<string, unknown>;
}

export interface GeminiRunResult {
  readonly text: string;
  readonly functionResponses: readonly GeminiFunctionResponse[];
  readonly denied: boolean;
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

      for (let turn = 0; turn < 12; turn += 1) {
        const response = await requestGemini(fetchFn, apiKey, contents, options.tools ?? [], timeoutMs);
        if (response.kind === "deny") {
          return { text: "", functionResponses, denied: true };
        }

        const functionCalls = functionCallsFrom(response.content);
        if (functionCalls.length === 0) {
          return { text: textFrom(response.content), functionResponses, denied: false };
        }

        const responseParts: Array<Record<string, unknown>> = [];
        for (const call of functionCalls) {
          // This await is deliberately adjacent to execution: ADR-011 §2.2.
          const decision = await decideFunctionCall(options.l1, call, toolByName);
          const functionResponse = await functionResponseFor(call, decision, toolByName);
          functionResponses.push(functionResponse);
          responseParts.push({ functionResponse });
        }

        contents.push(response.content, { role: "user", parts: responseParts });
      }

      return { text: "", functionResponses, denied: true };
    },
  };
}

async function decideFunctionCall(
  l1: PreToolUseHookPort,
  call: GeminiFunctionCall,
  toolByName: ReadonlyMap<string, GeminiTool>,
): Promise<{ allow: true; input: Record<string, unknown> } | { allow: false; message: string }> {
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

  const tool = toolByName.get(call.name);
  if (tool === undefined) {
    return { allow: false, message: "Gemini requested an unknown tool" };
  }
  if (tool.tier !== STAGE_ONE_MAXIMUM_TOOL_TIER) {
    return { allow: false, message: "Gemini Stage 1 permits Tier-0 tools only" };
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

type GeminiResponse = { kind: "content"; content: Record<string, unknown> } | { kind: "deny" };

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
      return { kind: "deny" };
    }
    const parsed: unknown = await response.json();
    const content = contentFrom(parsed);
    return content === undefined ? { kind: "deny" } : { kind: "content", content };
  } catch {
    return { kind: "deny" };
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

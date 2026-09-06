import type { ActionDescription, ToolCall } from "./describe.js";

export const REQUEST_SECRET_TOOL = "mcp__workspace__request_secret";
export const REQUEST_SECRET_CAPABILITY_ID = "workspace.request_secret";
export const REQUEST_SECRET_LABEL_MAX_CHARS = 200;
export const REQUEST_SECRET_PURPOSE_MAX_CHARS = 2_000;

export interface RequestSecretInput { label: string; purpose: string; }

function field(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${name} must not be empty.`);
  if (trimmed.length > maximum) throw new Error(`${name} must be at most ${maximum} characters.`);
  return trimmed;
}

/** Validates before L1 issues an approval and rejects unrecognised fields. */
export function parseRequestSecretInput(value: unknown): RequestSecretInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("request_secret requires an object input.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 2 || !Object.hasOwn(input, "label") || !Object.hasOwn(input, "purpose")) {
    throw new Error("request_secret requires exactly label and purpose.");
  }
  return { label: field(input.label, "label", REQUEST_SECRET_LABEL_MAX_CHARS), purpose: field(input.purpose, "purpose", REQUEST_SECRET_PURPOSE_MAX_CHARS) };
}

/** A registered derived description makes invalid/unpresentable payloads fail closed before approval. */
export function describeRequestSecret(call: ToolCall): ActionDescription | undefined {
  try {
    const input = parseRequestSecretInput(call.input);
    return { action: "request secret", target: `${input.label} — ${input.purpose}` };
  } catch { return undefined; }
}

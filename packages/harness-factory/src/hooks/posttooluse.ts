/**
 * R4 PostToolUse adapter (OIK-037 / ADR-001 R4).
 *
 * The completion record deliberately correlates with the L1 decision by
 * `toolUseId`.  The audit sink is injected: this adapter owns neither a
 * database connection nor a second audit-writer implementation.
 */

import { actionDigest, type JsonValue } from "@oikonomos/shared";

import type { PostToolUseHookPort, PostToolUsePortRequest } from "../ports.js";

export interface CompletionEvidence {
  readonly toolUseId: string;
  readonly toolName: string;
  readonly resultDigest: string;
  readonly artifactUris: readonly string[];
}

/** Injected append-only audit-writer seam, supplied by the composition root. */
export interface CompletionAuditSink {
  writeCompletionEvidence(evidence: CompletionEvidence): Promise<void>;
}

export interface PostToolUseHookOptions {
  auditSink: CompletionAuditSink;
}

/**
 * Creates the R4 adapter. Audit write failures intentionally reject through
 * the hook callback; treating an unaudited completion as successful would
 * silently drop required evidence.
 */
export function createPostToolUseHook(options: PostToolUseHookOptions): PostToolUseHookPort {
  assertOptions(options);

  return {
    async handle(request: PostToolUsePortRequest): Promise<void> {
      const evidence = toCompletionEvidence(request);
      await options.auditSink.writeCompletionEvidence(evidence);
    },
  };
}

/** Builds the append-only completion evidence supplied to the injected sink. */
export function toCompletionEvidence(request: PostToolUsePortRequest): CompletionEvidence {
  if (typeof request?.toolUseId !== "string" || request.toolUseId.length === 0) {
    throw new Error("PostToolUse completion evidence requires toolUseId");
  }
  if (typeof request.toolName !== "string" || request.toolName.length === 0) {
    throw new Error("PostToolUse completion evidence requires toolName");
  }

  const toolResponse = asJsonValue(request.toolResponse, "toolResponse");
  const artifactUris = extractArtifactUris(toolResponse);

  return Object.freeze({
    toolUseId: request.toolUseId,
    toolName: request.toolName,
    resultDigest: actionDigest({
      toolName: request.toolName,
      input: toolResponse,
      destination: artifactUris,
    }),
    artifactUris: Object.freeze(artifactUris),
  });
}

/**
 * Extract explicit artifact URI fields from a tool result. Both SDK-style
 * camelCase and wire-style snake_case keys are accepted at any nesting level.
 */
export function extractArtifactUris(response: JsonValue): string[] {
  const uris = new Set<string>();
  visit(response, uris);
  return [...uris].sort();
}

function assertOptions(options: PostToolUseHookOptions): void {
  if (typeof options?.auditSink?.writeCompletionEvidence !== "function") {
    throw new Error("PostToolUse requires an injected completion audit sink");
  }
}

function asJsonValue(value: unknown, field: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`PostToolUse ${field} must contain only finite JSON numbers`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => asJsonValue(entry, `${field}[${index}]`));
  }
  if (typeof value === "object" && value !== null) {
    const result: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = asJsonValue(entry, `${field}.${key}`);
    }
    return result;
  }
  throw new Error(`PostToolUse ${field} must be JSON-serializable`);
}

function visit(value: JsonValue, uris: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      visit(entry, uris);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    if ((key === "artifactUri" || key === "artifact_uri") && typeof entry === "string") {
      addUri(entry, uris);
    } else if ((key === "artifactUris" || key === "artifact_uris") && Array.isArray(entry)) {
      for (const uri of entry) {
        if (typeof uri === "string") {
          addUri(uri, uris);
        }
      }
    }
    visit(entry, uris);
  }
}

function addUri(value: string, uris: Set<string>): void {
  const uri = value.trim();
  if (uri.length > 0) {
    uris.add(uri);
  }
}

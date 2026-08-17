import { actionDigest } from "@oikonomos/shared";
import { describe, expect, it, vi } from "vitest";

import {
  createPostToolUseHook,
  extractArtifactUris,
  toCompletionEvidence,
  type CompletionAuditSink,
} from "../../src/hooks/posttooluse.js";

describe("createPostToolUseHook — R4 completion evidence", () => {
  it("writes a result digest and artifact URIs keyed by the L1 toolUseId", async () => {
    const sink: CompletionAuditSink = { writeCompletionEvidence: vi.fn(async () => undefined) };
    const response = {
      status: "complete",
      artifactUris: ["evidence://run/report", " evidence://run/log "],
      content: [{ artifact_uri: "evidence://run/screenshot" }],
    };

    await createPostToolUseHook({ auditSink: sink }).handle({
      toolName: "Browser",
      toolUseId: "tool-use-from-l1",
      input: { url: "https://example.test" },
      toolResponse: response,
    });

    expect(sink.writeCompletionEvidence).toHaveBeenCalledOnce();
    expect(sink.writeCompletionEvidence).toHaveBeenCalledWith({
      toolUseId: "tool-use-from-l1",
      toolName: "Browser",
      artifactUris: [
        "evidence://run/log",
        "evidence://run/report",
        "evidence://run/screenshot",
      ],
      resultDigest: actionDigest({
        toolName: "Browser",
        input: response,
        destination: [
          "evidence://run/log",
          "evidence://run/report",
          "evidence://run/screenshot",
        ],
      }),
    });
  });

  it("uses the shared canonical JSON digest for stable response key ordering", () => {
    const first = toCompletionEvidence({
      toolName: "Read",
      toolUseId: "tool-1",
      input: {},
      toolResponse: { z: 1, artifactUri: "evidence://run/file", a: { y: true, x: false } },
    });
    const second = toCompletionEvidence({
      toolName: "Read",
      toolUseId: "tool-2",
      input: {},
      toolResponse: { a: { x: false, y: true }, artifactUri: "evidence://run/file", z: 1 },
    });

    expect(first.resultDigest).toBe(second.resultDigest);
    expect(first.resultDigest).toBe(
      actionDigest({
        toolName: "Read",
        input: { a: { x: false, y: true }, artifactUri: "evidence://run/file", z: 1 },
        destination: ["evidence://run/file"],
      }),
    );
  });

  it("deduplicates and deterministically sorts explicit artifact URI fields", () => {
    expect(
      extractArtifactUris({
        nested: { artifact_uri: "evidence://b" },
        artifactUris: ["evidence://a", "evidence://b", "  "],
      }),
    ).toEqual(["evidence://a", "evidence://b"]);
  });

  it("surfaces audit write failures rather than silently dropping evidence", async () => {
    const failure = new Error("audit unavailable");
    const hook = createPostToolUseHook({
      auditSink: { writeCompletionEvidence: vi.fn(async () => Promise.reject(failure)) },
    });

    await expect(
      hook.handle({ toolName: "Write", toolUseId: "tool-3", input: {}, toolResponse: { ok: true } }),
    ).rejects.toBe(failure);
  });

  it("rejects malformed constructor options and non-JSON tool responses", async () => {
    expect(() => createPostToolUseHook({ auditSink: {} as CompletionAuditSink })).toThrow(
      /injected completion audit sink/,
    );

    const hook = createPostToolUseHook({
      auditSink: { writeCompletionEvidence: async () => undefined },
    });
    await expect(
      hook.handle({ toolName: "Read", toolUseId: "tool-4", input: {}, toolResponse: undefined }),
    ).rejects.toThrow(/JSON-serializable/);
  });
});

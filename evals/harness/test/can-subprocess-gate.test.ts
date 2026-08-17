import { describe, expect, it } from "vitest";

import { handlePreToolUse } from "@oikonomos/broker";

import { canaryCompose, createBrokerDeps } from "./helpers.js";

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) {
    out.push(item);
  }
  return out;
}

describe("compose subprocess gate — deny means no OS spawn", () => {
  it("Codex and Grok emit a deny error and never spawn the missing binary", async () => {
    const built = createBrokerDeps();
    const { composed } = canaryCompose({
      pretooluse: { handlePreToolUse, dependencies: built.deps },
    });

    const signal = new AbortController().signal;
    const opts = {
      prompt: "must not reach the OS",
      cwd: process.cwd(),
      sessionId: null,
      model: null,
      signal,
    };

    const codex = composed.providers.codex;
    const grok = composed.providers.grok;
    expect(codex).toBeDefined();
    expect(grok).toBeDefined();

    const [codexEvents, grokEvents] = await Promise.all([
      collect(codex!.sendPrompt(opts)),
      collect(grok!.sendPrompt(opts)),
    ]);

    expect(codexEvents).toHaveLength(1);
    expect(grokEvents).toHaveLength(1);
    expect(codexEvents[0]).toMatchObject({ type: "error", fatal: true });
    expect(grokEvents[0]).toMatchObject({ type: "error", fatal: true });
    expect(String((codexEvents[0] as { message: string }).message)).toMatch(
      /Codex spawn denied: approval_pending/,
    );
    expect(String((grokEvents[0] as { message: string }).message)).toMatch(
      /Grok spawn denied: approval_pending/,
    );
    expect(String((codexEvents[0] as { message: string }).message)).not.toMatch(/ENOENT/);
    expect(String((grokEvents[0] as { message: string }).message)).not.toMatch(/ENOENT/);
  });
});

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { actionDigest } from "../src/actionDigest.js";

/**
 * Transpiles src/canonicalJson.ts and src/actionDigest.ts (the actual
 * shipped source — not a reimplementation) into plain ESM `.mjs` files in a
 * scratch directory, plus a tiny runner that computes one action digest
 * from argv and prints it. This lets the "reproducible across processes"
 * acceptance criterion spawn a real, separate `node` process running the
 * genuine implementation, without requiring a prior `pnpm build` step.
 */
function buildChildProject(): { dir: string; runnerPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "oik-task003-repro-"));

  const canonicalJsonSrc = ts.transpileModule(
    readFileSync(new URL("../src/canonicalJson.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;

  const actionDigestSrcRaw = readFileSync(
    new URL("../src/actionDigest.ts", import.meta.url),
    "utf8",
  );
  const actionDigestSrc = ts
    .transpileModule(actionDigestSrcRaw, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    })
    .outputText.replace('from "./canonicalJson.js"', 'from "./canonicalJson.mjs"');

  writeFileSync(join(dir, "canonicalJson.mjs"), canonicalJsonSrc, "utf8");
  writeFileSync(join(dir, "actionDigest.mjs"), actionDigestSrc, "utf8");

  const runnerPath = join(dir, "runner.mjs");
  writeFileSync(
    runnerPath,
    [
      'import { actionDigest } from "./actionDigest.mjs";',
      "const action = JSON.parse(process.argv[2]);",
      "process.stdout.write(actionDigest(action));",
      "",
    ].join("\n"),
    "utf8",
  );

  return { dir, runnerPath };
}

describe("actionDigest — reproducible across processes", () => {
  it("a digest computed in a spawned child process matches the one computed in-process", () => {
    const { dir, runnerPath } = buildChildProject();
    try {
      const action = {
        toolName: "mcp__gmail__create_draft",
        input: { to: "placeholder@example.com", subject: "test", body: "café 😀" },
        destination: "draft",
      };
      const inProcessDigest = actionDigest(action);

      const result = spawnSync(process.execPath, [runnerPath, JSON.stringify(action)], {
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const childDigest = result.stdout;
      expect(childDigest).toBe(inProcessDigest);
      expect(childDigest).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("three independent child processes computing the same action all agree with each other", () => {
    const { dir, runnerPath } = buildChildProject();
    try {
      const action = { toolName: "t", input: { n: 1, s: "x", nested: { a: [1, 2, 3] } }, destination: "d" };
      const digests = [0, 1, 2].map(() => {
        const result = spawnSync(process.execPath, [runnerPath, JSON.stringify(action)], {
          encoding: "utf8",
        });
        expect(result.status).toBe(0);
        return result.stdout;
      });
      expect(new Set(digests).size).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { GoldenEvalError, runSuite, validateSuite } from "../src/index.js";

const manifest = { connector_id: "_fixture", evals: { suite: "evals/golden/suites/_fixture", min_pass_rate: 0.9 } };
const suitesRoot = fileURLToPath(new URL("../suites/", import.meta.url));

const fakeQuery = async function* (input: { prompt: string | AsyncIterable<unknown> }) {
  if (typeof input.prompt === "string") yield { text: input.prompt.includes("failing") ? "intentionally incomplete" : "draft prepared" };
};

describe("golden connector eval runner", () => {
  it("runs the three-task fixture through the harness seam and reports pass rate", async () => {
    const report = await runSuite("_fixture", { manifest, queryFn: fakeQuery, suitesRoot });
    expect(report.harness_invocations).toBe(3);
    expect(report.tasks).toHaveLength(3);
    expect(report.pass_rate).toBeCloseTo(2 / 3);
    expect(report.passed).toBe(false);
  });

  it("rejects Tier-3 task configuration at suite validation", () => {
    expect(() => validateSuite({ connector_id: "fixture", tasks: [{ id: "x", prompt: "x", expected_outcome: { contains: ["x"] }, allowed_tiers: ["T3_external"] }] })).toThrow();
  });

  it("fails an empty suite as unobservable", async () => {
    const root = await mkdtemp(join(tmpdir(), "golden-evals-"));
    await mkdir(join(root, "empty"));
    await writeFile(join(root, "empty", "suite.yaml"), "connector_id: empty\ntasks: []\n");
    await expect(runSuite("empty", { manifest: { connector_id: "empty", evals: { suite: "ignored", min_pass_rate: 0.9 } }, queryFn: fakeQuery, suitesRoot: root })).rejects.toMatchObject({ code: "UNOBSERVABLE" } satisfies Partial<GoldenEvalError>);
  });

  it("rejects a manifest pass rate below the connector quality bar", async () => {
    await expect(runSuite("_fixture", { manifest: { ...manifest, evals: { ...manifest.evals, min_pass_rate: 0.8 } }, queryFn: fakeQuery, suitesRoot })).rejects.toMatchObject({ code: "CONFIGURATION" });
  });
});

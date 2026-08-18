import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runValidateCli } from "../src/index.js";
import { handoverGmailObject, handoverGmailYaml, yamlFrom } from "./helpers.js";

function captureIo(): {
  stdout: string[];
  stderr: string[];
  io: { stdout: { write(chunk: string): void }; stderr: { write(chunk: string): void } };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: { write(chunk: string) { stdout.push(chunk); } },
      stderr: { write(chunk: string) { stderr.push(chunk); } },
    },
  };
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "oik-cli-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("validate CLI", () => {
  it("exits 0 only when every manifest is valid and at least one was found", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "gmail.yaml"), handoverGmailYaml(), "utf8");
      const cap = captureIo();
      const code = await runValidateCli(["--dir", dir], cap.io);
      expect(code).toBe(0);
      expect(cap.stdout.join("")).toMatch(/ok: 1 manifest/);
    });
  });

  it("exits non-zero naming file + field for each violation", async () => {
    await withTempDir(async (dir) => {
      const doc = handoverGmailObject();
      doc.account_ownership = "third-party";
      await writeFile(join(dir, "evil.yaml"), yamlFrom(doc), "utf8");
      const cap = captureIo();
      const code = await runValidateCli(["--dir", dir], cap.io);
      expect(code).toBe(1);
      const err = cap.stderr.join("");
      expect(err).toContain("evil.yaml");
      expect(err).toContain("account_ownership");
    });
  });

  it("exits non-zero as UNOBSERVABLE on a missing directory", async () => {
    const missing = join(tmpdir(), `oik-cli-missing-${Date.now()}`);
    const cap = captureIo();
    const code = await runValidateCli(["--dir", missing], cap.io);
    expect(code).toBe(1);
    expect(cap.stderr.join("")).toMatch(/UNOBSERVABLE: manifests directory missing/);
  });

  it("exits non-zero as UNOBSERVABLE when zero manifests are found", async () => {
    await withTempDir(async (dir) => {
      const cap = captureIo();
      const code = await runValidateCli(["--dir", dir], cap.io);
      expect(code).toBe(1);
      expect(cap.stderr.join("")).toMatch(/UNOBSERVABLE: zero manifests/);
    });
  });
});

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const scanRoots = [join(repoRoot, "packages"), join(repoRoot, "services")];

const SDK_MODULE = "@anthropic-ai/claude-agent-sdk";
const SOURCE_EXT = /\.(?:[cm]?[jt]s|tsx)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage"]);

function isHarnessFactory(absPath: string): boolean {
  const rel = relative(repoRoot, absPath).split(sep).join("/");
  return rel === "packages/harness-factory" || rel.startsWith("packages/harness-factory/");
}

function walkSources(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const abs = join(dir, name);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      out.push(...walkSources(abs));
      continue;
    }
    if (SOURCE_EXT.test(name)) {
      out.push(abs);
    }
  }
  return out;
}

function sdkImportHits(body: string): string[] {
  const hits: string[] = [];
  const patterns = [
    /from\s+["']@anthropic-ai\/claude-agent-sdk(?:\/[^"']*)?["']/,
    /require\(\s*["']@anthropic-ai\/claude-agent-sdk(?:\/[^"']*)?["']\s*\)/,
    /import\(\s*["']@anthropic-ai\/claude-agent-sdk(?:\/[^"']*)?["']\s*\)/,
  ];
  for (const pattern of patterns) {
    if (pattern.test(body)) {
      hits.push(pattern.source);
    }
  }
  return hits;
}

function strayConstructorHits(body: string): string[] {
  const hits: string[] = [];
  if (/\b(?:export\s+)?(?:async\s+)?function\s+createHarness\b/.test(body)) {
    hits.push("function createHarness");
  }
  if (/\bexport\s+const\s+createHarness\b/.test(body)) {
    hits.push("export const createHarness");
  }
  return hits;
}

describe("N9 — sole harness constructor", () => {
  it("this package is the only construction path for the Agent SDK query()", () => {
    const factorySrc = readFileSync(join(repoRoot, "packages/harness-factory/src/index.ts"), "utf8");
    expect(factorySrc).toContain("createHarness");
    expect(factorySrc).toContain(SDK_MODULE);

    const violations: string[] = [];
    for (const root of scanRoots) {
      for (const file of walkSources(root)) {
        if (isHarnessFactory(file)) continue;
        const body = readFileSync(file, "utf8");
        const rel = relative(repoRoot, file).split(sep).join("/");
        for (const hit of sdkImportHits(body)) {
          violations.push(`${rel}: Agent SDK import (${hit})`);
        }
        for (const hit of strayConstructorHits(body)) {
          violations.push(`${rel}: ${hit}`);
        }
      }
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });
});

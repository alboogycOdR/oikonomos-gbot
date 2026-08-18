import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export function handoverGmailYaml(): string {
  return readFileSync(join(fixturesDir, "gmail.handover.yaml"), "utf8");
}

export function handoverGmailObject(): Record<string, unknown> {
  const parsed: unknown = parseYaml(handoverGmailYaml());
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("gmail handover fixture is not a mapping");
  }
  return parsed as Record<string, unknown>;
}

export function yamlFrom(value: unknown): string {
  return stringifyYaml(value);
}

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultManifestsDir, scanManifests } from "./scan.js";

export interface CliIo {
  readonly stdout: { write(chunk: string): void };
  readonly stderr: { write(chunk: string): void };
}

export function parseManifestsDir(argv: readonly string[]): string {
  const dirFlag = argv.indexOf("--dir");
  if (dirFlag !== -1) {
    const value = argv[dirFlag + 1];
    if (value === undefined || value.length === 0 || value.startsWith("-")) {
      throw new Error("--dir requires a path");
    }
    return resolve(value);
  }
  return defaultManifestsDir();
}

/**
 * Scan connector manifests and print every violation as `file: field: message`.
 * Exit 0 only when every file is valid AND at least one file was found.
 */
export async function runValidateCli(
  argv: readonly string[],
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  let dir: string;
  try {
    dir = parseManifestsDir(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid arguments";
    io.stderr.write(`${message}\n`);
    return 1;
  }

  const result = await scanManifests(dir);
  if (result.ok) {
    io.stdout.write(`ok: ${result.files.length} manifest(s)\n`);
    return 0;
  }

  if (result.unobservable !== undefined) {
    io.stderr.write(`${result.message}\n`);
    return 1;
  }

  for (const violation of result.violations) {
    io.stderr.write(`${violation.file}: ${violation.field}: ${violation.message}\n`);
  }
  if (result.violations.length === 0) {
    io.stderr.write(`${result.message}\n`);
  }
  return 1;
}

function isExecutedAsCli(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return fileURLToPath(import.meta.url) === resolve(entry);
}

if (isExecutedAsCli()) {
  void runValidateCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

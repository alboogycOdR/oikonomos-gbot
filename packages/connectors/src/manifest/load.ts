import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { scanManifests } from "./scan.js";
import { validateManifest, type ManifestIssue } from "./validate.js";
import type { ConnectorManifest } from "./schema.js";

/**
 * Thrown by {@link loadManifests} when any file under `dir` fails `validateManifest`.
 * ADR-013 §2: "read + validateManifest, throw on any issue" — a manifest directory
 * with an invalid file is never partially loaded.
 */
export class InvalidManifestError extends Error {
  readonly file: string;
  readonly issues: readonly ManifestIssue[];

  constructor(file: string, issues: readonly ManifestIssue[]) {
    const detail = issues.map((issue) => `${issue.field}: ${issue.message}`).join("; ");
    super(`invalid connector manifest '${file}': ${detail}`);
    this.name = "InvalidManifestError";
    this.file = file;
    this.issues = issues;
  }
}

/**
 * Loads and validates every connector manifest under `dir`.
 *
 * ADR-013 §2: reuses {@link scanManifests} (directory walk + per-file
 * `validateManifest`) purely for its liveness/enumeration guarantees, then
 * re-reads and re-parses each file to hand back the validated
 * {@link ConnectorManifest} objects themselves — `scanManifests` returns file
 * names, not manifests (ADR-013 "Corrections to the problem statement" #2).
 *
 * Throws (does not silently skip) on:
 *  - a missing/empty manifests directory (surfaces `scanManifests`'s
 *    UNOBSERVABLE message unchanged), or
 *  - any file failing `validateManifest` ({@link InvalidManifestError}).
 */
export async function loadManifests(dir: string): Promise<ConnectorManifest[]> {
  const scanned = await scanManifests(dir);
  if (!scanned.ok) {
    if (scanned.violations.length > 0) {
      const first = scanned.violations[0];
      throw new InvalidManifestError(
        first.file,
        scanned.violations.filter((violation) => violation.file === first.file),
      );
    }
    throw new Error(scanned.message);
  }

  const manifests: ConnectorManifest[] = [];
  for (const relativeFile of scanned.files) {
    const absolute = join(dir, relativeFile);
    const raw = await readFile(absolute, "utf8");
    const result = validateManifest(raw);
    if (!result.ok) {
      throw new InvalidManifestError(relativeFile, result.issues);
    }
    manifests.push(result.manifest);
  }

  return manifests;
}

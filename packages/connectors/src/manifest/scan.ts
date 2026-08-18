import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { validateManifest, type ManifestIssue } from "./validate.js";

export const UNOBSERVABLE_MISSING_DIR = "UNOBSERVABLE: manifests directory missing";
export const UNOBSERVABLE_ZERO_MANIFESTS = "UNOBSERVABLE: zero manifests";

const MANIFEST_EXTENSIONS = new Set([".yaml", ".yml"]);

export function defaultManifestsDir(): string {
  return fileURLToPath(new URL("../../manifests", import.meta.url));
}

export interface FileViolation {
  readonly file: string;
  readonly field: string;
  readonly message: string;
}

export type ScanManifestsResult =
  | {
      readonly ok: true;
      readonly files: readonly string[];
    }
  | {
      readonly ok: false;
      readonly unobservable?: "missing_dir" | "zero_manifests";
      readonly message: string;
      readonly violations: readonly FileViolation[];
    };

function isManifestFile(name: string): boolean {
  return MANIFEST_EXTENSIONS.has(extname(name).toLowerCase());
}

async function listManifestFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listManifestFiles(full)));
    } else if (entry.isFile() && isManifestFile(entry.name)) {
      files.push(full);
    }
  }
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

export async function scanManifests(dir: string): Promise<ScanManifestsResult> {
  let info;
  try {
    info = await stat(dir);
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "";
    if (code === "ENOENT") {
      return {
        ok: false,
        unobservable: "missing_dir",
        message: `${UNOBSERVABLE_MISSING_DIR}: ${dir}`,
        violations: [],
      };
    }
    return {
      ok: false,
      message: `failed to stat manifests directory: ${dir}`,
      violations: [],
    };
  }

  if (!info.isDirectory()) {
    return {
      ok: false,
      unobservable: "missing_dir",
      message: `${UNOBSERVABLE_MISSING_DIR}: ${dir} is not a directory`,
      violations: [],
    };
  }

  const files = await listManifestFiles(dir);
  if (files.length === 0) {
    return {
      ok: false,
      unobservable: "zero_manifests",
      message: `${UNOBSERVABLE_ZERO_MANIFESTS} under ${dir}`,
      violations: [],
    };
  }

  const violations: FileViolation[] = [];
  for (const absolute of files) {
    const raw = await readFile(absolute, "utf8");
    const result = validateManifest(raw);
    const rel = relative(dir, absolute).replaceAll("\\", "/");
    if (!result.ok) {
      for (const issue of result.issues as readonly ManifestIssue[]) {
        violations.push({ file: rel, field: issue.field, message: issue.message });
      }
    }
  }

  if (violations.length > 0) {
    return { ok: false, message: "invalid manifest(s)", violations };
  }

  return {
    ok: true,
    files: files.map((absolute) => relative(dir, absolute).replaceAll("\\", "/")),
  };
}

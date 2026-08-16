/**
 * TASK-024 / ADR-005: ATLAS index liveness is coverage of the MAIN checkout.
 *
 * `.devteam/` is gitignored, so every worktree has its own atlas.db.
 * dispatch.ps1 runs `atlas.py scan` from the main checkout only and never
 * refreshes a builder worktree copy. Reading this worktree's index would
 * assert against state no process maintains, and cannot be satisfied from
 * inside a task. Resolve the main checkout via `git rev-parse --git-common-dir`
 * (the same handle the territory hook already uses) and read THAT atlas.db.
 *
 * Key on coverage, not recency. Commit-count and scan-timestamp checks drift
 * with every ORCH PLAN.md commit and were unsatisfiable three times (TASK-021).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const READ_PATHS = join(here, 'read-atlas-paths.py');

/**
 * Keep in sync with scripts/atlas_core.py TEXT_EXTENSIONS. Drift here would
 * hide missing source files or inflate the lag window with false misses.
 */
export const ATLAS_TEXT_EXTENSIONS = new Set([
  '.py', '.js', '.jsx', '.ts', '.tsx', '.dart', '.mq5', '.mqh',
  '.md', '.json', '.yaml', '.yml', '.ps1', '.sh', '.txt',
]);

/**
 * Files the main-checkout scan may lag behind master, or that the scanner
 * legitimately skips (NUL bytes / undecodable bodies with a text suffix).
 * Measured 2026-08-16 from this worktree: 1 of 256 tracked indexable files
 * absent (`packages/shared/test/prng.ts`) against the TASK-024 diagnosis of
 * 4 of 257. An empty, missing, or largely dropped index still fails closed.
 */
export const ATLAS_COVERAGE_TOLERANCE = 8;

function slash(value) {
  return String(value).replace(/\\/g, '/');
}

function gitEnv(overrides) {
  const env = { ...process.env, ...overrides };
  if (!overrides || !('GIT_DIR' in overrides)) delete env.GIT_DIR;
  if (!overrides || !('GIT_WORK_TREE' in overrides)) delete env.GIT_WORK_TREE;
  return env;
}

function command(bin, args, cwd, env) {
  const result = spawnSync(bin, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: env ?? gitEnv(),
  });
  return {
    status: result.error ? 1 : (result.status ?? 1),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

export function resolveMainCheckoutRoot(root, env) {
  const result = command('git', ['rev-parse', '--git-common-dir'], root, env);
  const commonDir = result.stdout.trim();
  if (result.status !== 0 || !commonDir) return null;
  return dirname(resolve(root, commonDir));
}

/**
 * Python fnmatch is not pathname-aware: `*` matches `/`. Replicate that so
 * atlas exclude globs such as star/dist/star behave the same here.
 */
export function fnmatch(name, pattern) {
  let expression = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      expression += '.*';
    } else if (char === '?') {
      expression += '.';
    } else if (char === '[') {
      const close = pattern.indexOf(']', index + 1);
      if (close === -1) {
        expression += '\\[';
      } else {
        expression += pattern.slice(index, close + 1);
        index = close;
      }
    } else {
      expression += char.replace(/[.+^${}()|\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${expression}$`).test(name);
}

export function isIgnored(rel, patterns) {
  const normalized = slash(rel).replace(/^\/+|\/+$/g, '');
  for (const raw of patterns) {
    let pattern = String(raw).trim().replace(/\\/g, '/');
    if (!pattern) continue;
    const directory = pattern.endsWith('/');
    pattern = pattern.replace(/^\/+|\/+$/g, '');
    if (directory && (normalized === pattern || normalized.startsWith(`${pattern}/`))) {
      return true;
    }
    if (fnmatch(normalized, pattern) || fnmatch(basename(normalized), pattern)) {
      return true;
    }
  }
  return false;
}

export function loadIgnorePatterns(mainRoot) {
  const patterns = ['.git/', '.devteam/'];
  const gitignore = join(mainRoot, '.gitignore');
  if (existsSync(gitignore)) {
    for (const raw of readFileSync(gitignore, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (line && !line.startsWith('#') && !line.startsWith('!')) {
        patterns.push(line);
      }
    }
  }
  const autopilot = join(mainRoot, 'autopilot.json');
  if (existsSync(autopilot)) {
    try {
      const data = JSON.parse(readFileSync(autopilot, 'utf8'));
      const extra = data?.atlas?.exclude;
      if (Array.isArray(extra)) {
        for (const pattern of extra) {
          if (pattern) patterns.push(String(pattern));
        }
      }
    } catch {
      // Unreadable exclude list is not a coverage miss; gitignore still applies.
    }
  }
  return patterns;
}

export function indexableTrackedFiles(tracked, patterns) {
  const files = [];
  for (const rel of tracked) {
    const normalized = slash(rel);
    if (!ATLAS_TEXT_EXTENSIONS.has(extname(normalized).toLowerCase())) continue;
    if (isIgnored(normalized, patterns)) continue;
    files.push(normalized);
  }
  return files;
}

export function readIndexedPaths(dbPath) {
  if (!existsSync(dbPath)) {
    return { paths: [], error: `ATLAS index missing at ${dbPath}; coverage is unobservable` };
  }
  const result = command('python', [READ_PATHS, dbPath], dirname(dbPath));
  if (result.status !== 0) {
    const detail = result.output.trim() || 'python could not read the ATLAS index';
    return { paths: [], error: `ATLAS index unreadable at ${dbPath}: ${detail}` };
  }
  return {
    paths: result.stdout.split(/\r?\n/).map((line) => slash(line.trim())).filter(Boolean),
    error: null,
  };
}

function listTrackedFiles(mainRoot, env) {
  const result = command('git', ['-C', mainRoot, 'ls-files'], mainRoot, env);
  if (result.status !== 0) {
    return {
      files: [],
      error: `cannot list tracked files in the main checkout (${mainRoot}): ${result.output.trim() || 'git ls-files failed'}`,
    };
  }
  return {
    files: result.stdout.split(/\r?\n/).map((line) => slash(line.trim())).filter(Boolean),
    error: null,
  };
}

function fail(error, extras = {}) {
  return {
    error,
    dbPath: extras.dbPath ?? null,
    mainRoot: extras.mainRoot ?? null,
    indexed: extras.indexed ?? [],
    indexable: extras.indexable ?? [],
    missing: extras.missing ?? [],
    tolerance: extras.tolerance ?? ATLAS_COVERAGE_TOLERANCE,
  };
}

/**
 * Observe the main checkout's ATLAS coverage. Never writes `.devteam/`.
 * Options let a self-test point the check at a fixture index.
 */
export function collectAtlasCoverageEvidence(root, options = {}) {
  const tolerance = Number.isInteger(options.tolerance) ? options.tolerance : ATLAS_COVERAGE_TOLERANCE;
  const env = options.env ?? gitEnv();
  const mainRoot = options.mainRoot ?? resolveMainCheckoutRoot(root, env);
  if (!mainRoot) {
    return fail(
      '[controls-live] UNOBSERVABLE ATLAS index: cannot resolve the main checkout from this location (git rev-parse --git-common-dir).',
    );
  }

  const dbPath = options.dbPath ?? join(mainRoot, '.devteam', 'atlas.db');
  let indexed = options.indexedPaths;
  if (!indexed) {
    const read = readIndexedPaths(dbPath);
    if (read.error) return fail(read.error, { mainRoot, dbPath, tolerance });
    indexed = read.paths;
  }

  let tracked = options.trackedFiles;
  if (!tracked) {
    const listed = listTrackedFiles(mainRoot, env);
    if (listed.error) return fail(listed.error, { mainRoot, dbPath, indexed, tolerance });
    tracked = listed.files;
  }

  const patterns = options.ignorePatterns ?? loadIgnorePatterns(mainRoot);
  const indexable = indexableTrackedFiles(tracked, patterns);
  const present = new Set(indexed.map(slash));
  const missing = indexable.filter((path) => !present.has(path));

  return {
    error: null,
    mainRoot,
    dbPath,
    indexed,
    indexable,
    missing,
    tolerance,
  };
}

export function checkAtlasCoverage(evidence) {
  if (!evidence) {
    return 'ATLAS index coverage is unobservable; collector returned no evidence';
  }
  if (evidence.error) return evidence.error;
  const missing = evidence.missing ?? [];
  const tolerance = Number.isInteger(evidence.tolerance) ? evidence.tolerance : ATLAS_COVERAGE_TOLERANCE;
  if (missing.length <= tolerance) return null;
  const indexedCount = Array.isArray(evidence.indexed) ? evidence.indexed.length : 0;
  const expectedCount = Array.isArray(evidence.indexable) ? evidence.indexable.length : missing.length;
  return (
    `ATLAS index missing ${missing.length} tracked indexable file(s) ` +
    `(${indexedCount} indexed / ${expectedCount} expected, tolerance ${tolerance}): ` +
    `${missing.join(', ')}`
  );
}

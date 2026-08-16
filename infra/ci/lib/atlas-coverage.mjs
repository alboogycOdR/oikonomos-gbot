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
 * Lag-window tolerance, derived from observed scan lag — not padded headroom.
 *
 * Recorded missing-file deltas against the live main-checkout index:
 *   1 (2026-08-16 worktree measurement, `packages/shared/test/prng.ts`),
 *   2 (ORCH re-review measurement),
 *   4 (TASK-024 spec-time diagnosis, 253/257).
 *
 * The window is therefore 4: the largest lag ever observed. A workspace
 * package is 4–25 indexable files (`packages/agent-providers` is 4;
 * `packages/policy` is 6). Tolerance 4 absorbs every recorded scan lag
 * and still fails a 5+-file package disappearing from the index — the
 * self-test deletes `packages/policy` (6 files) from a fixture and
 * requires a non-zero result. An empty, missing, or unreadable index
 * still fails closed regardless of this number.
 */
export const ATLAS_COVERAGE_TOLERANCE = 4;

/** Same three-way probe as scripts/dispatch.ps1 / harness-audit.ps1. */
export const PYTHON_CANDIDATES = Object.freeze(['python', 'python3', 'py']);

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
    error: result.error ?? null,
  };
}

/**
 * Resolve a usable Python interpreter. Bare `python` is missing on many
 * POSIX / WSL boxes that only ship `python3`; hosted CI never runs this
 * check, so a single-name spawn would go spuriously red against a healthy
 * index. Returns null when none of the candidates can execute.
 */
export function resolvePythonInterpreter(env) {
  const probeEnv = env ?? gitEnv();
  for (const bin of PYTHON_CANDIDATES) {
    const result = command(bin, ['-c', 'import sys'], undefined, probeEnv);
    if (result.status === 0) return bin;
  }
  return null;
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

export function readIndexedPaths(dbPath, env) {
  if (!existsSync(dbPath)) {
    return { paths: [], error: `ATLAS index missing at ${dbPath}; coverage is unobservable` };
  }
  const python = resolvePythonInterpreter(env);
  if (!python) {
    return {
      paths: [],
      error:
        `Python interpreter missing (tried ${PYTHON_CANDIDATES.join(', ')}); ` +
        `cannot read the ATLAS index at ${dbPath}`,
    };
  }
  const result = command(python, [READ_PATHS, dbPath], dirname(dbPath), env);
  if (result.status !== 0) {
    const spawnDetail = result.error?.code === 'ENOENT'
      ? `${python} disappeared from PATH while reading the index`
      : result.error?.message;
    const detail = result.output.trim() || spawnDetail || `${python} could not read the ATLAS index`;
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
    const read = readIndexedPaths(dbPath, env);
    if (read.error) return fail(read.error, { mainRoot, dbPath, tolerance });
    indexed = read.paths;
  }

  let tracked = options.trackedFiles;
  if (!tracked) {
    const listed = listTrackedFiles(mainRoot, env);
    if (listed.error) return fail(listed.error, { mainRoot, dbPath, indexed, tolerance });
    tracked = listed.files;
  }
  if (tracked.length === 0) {
    return fail(
      `ATLAS coverage is unobservable: git ls-files returned no tracked files in the main checkout (${mainRoot})`,
      { mainRoot, dbPath, indexed, tolerance },
    );
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

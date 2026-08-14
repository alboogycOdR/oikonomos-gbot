import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';

/**
 * Strip inherited git env so probes against fixture trees are not polluted by
 * the caller's worktree (GIT_DIR / GIT_WORK_TREE). Without this, a temp dir
 * outside any repo can still look "inside a work tree".
 */
function gitEnv() {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  return env;
}

/**
 * Hard skip during the filesystem walk (performance + always-safe noise).
 * These are never scanned even when git is available.
 */
export const SKIP_DIRS = new Set([
  '.git',
  '.turbo',
  '.pnpm-store',
  'node_modules',
  'dist',
  'coverage',
]);

/**
 * Fallback directory basenames skipped when `git` is unavailable or the scan
 * root is not a git work tree. Prefer gitignore membership via
 * `git check-ignore --stdin` when git works — this list exists so CI containers
 * without git (or non-repo fixture trees) still skip known machine-local noise
 * such as `.devteam/`.
 *
 * An ignored path is skipped because it is not part of the scannable tree, never
 * because it is an ADR-002 Amendment A allowlist carve-out. Enforcement surfaces
 * under a matching gitignore entry are therefore omitted without weakening
 * Amendment A.
 */
export const FALLBACK_SKIP_DIRS = Object.freeze(
  new Set([
    ...SKIP_DIRS,
    '.devteam',
  ]),
);

export const SKIP_EXTS = new Set([
  '.7z',
  '.bin',
  '.db',
  '.dll',
  '.eot',
  '.exe',
  '.gif',
  '.gz',
  '.ico',
  '.jpeg',
  '.jpg',
  '.mp4',
  '.pdf',
  '.png',
  '.ttf',
  '.webp',
  '.woff',
  '.woff2',
  '.zip',
]);

export function repoRoot(start = process.cwd()) {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

export function relPosix(root, absPath) {
  return relative(root, absPath).split('\\').join('/');
}

export function shouldSkipFile(absPath) {
  const ext = extname(absPath).toLowerCase();
  return SKIP_EXTS.has(ext);
}

/**
 * True when `root` is itself a git work-tree root (has a `.git` entry) and the
 * `git` binary confirms it. Parent-repo pollution (e.g. a home-directory git
 * repo wrapping %TEMP%) must not enable check-ignore for fixture trees.
 */
export function isInsideGitWorkTree(root) {
  const absRoot = resolve(root);
  // Only the scan root counts — not an ancestor. Worktrees use a `.git` file.
  if (!existsSync(join(absRoot, '.git'))) return false;
  try {
    const result = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: absRoot,
      encoding: 'utf8',
      env: gitEnv(),
      windowsHide: true,
    });
    return result.status === 0 && String(result.stdout || '').trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Return the subset of repo-relative posix paths that git reports as ignored.
 * Empty set when git fails closed to "nothing ignored" is wrong — callers that
 * need fail-open should not use this alone; walkFiles falls back to
 * FALLBACK_SKIP_DIRS when the work-tree probe fails.
 *
 * `git check-ignore` exit codes: 0 = some matches, 1 = no matches, both OK.
 */
export function gitIgnoredPaths(root, relPaths) {
  const ignored = new Set();
  if (!relPaths || relPaths.length === 0) return ignored;

  const absRoot = resolve(root);
  const input = `${relPaths.map((p) => p.replace(/\\/g, '/')).join('\0')}\0`;
  let result;
  try {
    result = spawnSync('git', ['check-ignore', '--stdin', '-z'], {
      cwd: absRoot,
      input,
      encoding: 'utf8',
      env: gitEnv(),
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
  } catch {
    return ignored;
  }

  // 128+ = hard failure (not a repo, git missing mid-run, etc.)
  if (result.status !== 0 && result.status !== 1) {
    return ignored;
  }

  const stdout = result.stdout || '';
  for (const entry of stdout.split('\0')) {
    if (!entry) continue;
    ignored.add(entry.replace(/\\/g, '/'));
  }
  return ignored;
}

/**
 * Resolve ignore strategy for a scan root.
 * - `git`: filter candidates with `git check-ignore --stdin`
 * - `fallback`: skip FALLBACK_SKIP_DIRS basenames during the walk
 */
export function resolveIgnoreMode(root) {
  if (isInsideGitWorkTree(root)) {
    return { mode: 'git', reason: 'git-check-ignore' };
  }
  return { mode: 'fallback', reason: 'git-unavailable-or-not-a-work-tree' };
}

/**
 * Walk `root` for scannable files.
 *
 * When inside a git work tree, candidates are filtered with
 * `git check-ignore --stdin` so .gitignore (and exclude) membership is honored.
 * When git is unavailable, FALLBACK_SKIP_DIRS is applied during the walk.
 *
 * Always skips SKIP_DIRS / SKIP_EXTS for performance and binary safety.
 */
export function walkFiles(root) {
  const absRoot = resolve(root);
  const { mode } = resolveIgnoreMode(absRoot);
  const dirSkip = mode === 'fallback' ? FALLBACK_SKIP_DIRS : SKIP_DIRS;
  const candidates = [];

  function visit(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? err.code : '';
      if (code === 'EACCES' || code === 'EPERM' || code === 'ENOENT') return;
      throw err;
    }

    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (dirSkip.has(entry.name)) continue;
        visit(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (shouldSkipFile(abs)) continue;
      try {
        if (!statSync(abs).isFile()) continue;
      } catch {
        continue;
      }
      candidates.push(abs);
    }
  }

  visit(absRoot);

  if (mode !== 'git' || candidates.length === 0) {
    return candidates;
  }

  const rels = candidates.map((abs) => relPosix(absRoot, abs));
  const ignored = gitIgnoredPaths(absRoot, rels);
  if (ignored.size === 0) return candidates;

  return candidates.filter((abs) => !ignored.has(relPosix(absRoot, abs)));
}

#!/usr/bin/env node
/**
 * ADR-005 control-liveness gate.
 *
 * This checks evidence emitted by the controls themselves.  It deliberately
 * does not treat an mtime, a configured setting, or a successful no-op as
 * proof that a control is live.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot } from './lib/walk.mjs';

function command(command, args, root, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env,
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

function walkFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function mainCheckoutRoot(root) {
  const commonDirResult = command('git', ['rev-parse', '--git-common-dir'], root);
  const commonDir = commonDirResult.output.trim();
  if (commonDirResult.status !== 0 || !commonDir) return null;
  return dirname(resolve(root, commonDir));
}

function registeredBuilderWorktrees(root, mainRoot) {
  let registry;
  try {
    registry = JSON.parse(readFileSync(join(mainRoot, 'autopilot.json'), 'utf8'));
  } catch (error) {
    return { roots: [], error: `cannot read builder registry: ${error.message}` };
  }

  const defined = registry?.builders?.defined;
  if (!defined || typeof defined !== 'object') {
    return { roots: [], error: 'builder registry has no defined worktree suffixes' };
  }

  const expected = new Set(
    Object.values(defined)
      .map((builder) => builder?.worktree_suffix)
      .filter(Boolean)
      .map((suffix) => resolve(dirname(mainRoot), `wt-${suffix}-${basename(mainRoot)}`)),
  );
  const worktreeResult = command('git', ['worktree', 'list', '--porcelain'], root);
  if (worktreeResult.status !== 0) {
    return { roots: [], error: `cannot enumerate registered worktrees: ${worktreeResult.output.trim()}` };
  }

  const roots = worktreeResult.output.split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => resolve(line.slice('worktree '.length)))
    .filter((worktree) => expected.has(worktree));
  return { roots, error: null };
}

/**
 * A main-checkout commit is deliberately unrestricted (ORCH). Probe a registered
 * builder worktree instead, where ADR-002's hook must reject the staged fixture.
 */
export function collectHookRejectionEvidence(root) {
  const mainRoot = mainCheckoutRoot(root);
  if (!mainRoot) {
    return { status: 1, output: '[controls-live] UNOBSERVABLE territory pre-commit hook: cannot resolve the main checkout from this location.' };
  }

  const builders = registeredBuilderWorktrees(root, mainRoot);
  if (builders.roots.length === 0) {
    const reason = builders.error ?? 'no registered builder worktree is currently available';
    return {
      status: 1,
      output: `[controls-live] UNOBSERVABLE territory pre-commit hook from ${mainRoot}: ${reason}.`,
    };
  }

  const probeRoot = builders.roots.includes(resolve(root)) ? resolve(root) : builders.roots[0];
  const hookPathResult = command('git', ['rev-parse', '--git-path', 'hooks/pre-commit'], probeRoot);
  if (hookPathResult.status !== 0 || !hookPathResult.output.trim()) {
    return { status: 1, output: `${hookPathResult.output}\nUnable to locate installed pre-commit hook.` };
  }

  const hookPath = hookPathResult.output.trim();
  const temp = mkdtempSync(join(tmpdir(), 'oikonomos-controls-live-'));
  const indexPath = join(temp, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    const readTree = command('git', ['read-tree', 'HEAD'], probeRoot, env);
    if (readTree.status !== 0) return readTree;
    const stageOutOfTerritoryPath = command('git', ['update-index', '--force-remove', '--', 'AGENTS.md'], probeRoot, env);
    if (stageOutOfTerritoryPath.status !== 0) return stageOutOfTerritoryPath;
    return command('git', ['hook', 'run', 'pre-commit'], probeRoot, env);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export function checkHookEvidence(result) {
  if (/\[controls-live\] UNOBSERVABLE territory pre-commit hook:/i.test(result.output)) {
    return result.output.trim();
  }
  if (result.status === 0) return 'installed territory pre-commit hook allowed an out-of-territory staged commit';
  if (!/\[territory-precommit\] COMMIT REJECTED/i.test(result.output)) {
    return 'installed pre-commit hook did not emit territory rejection evidence';
  }
  return null;
}

export function checkControlQueue(queue) {
  if (!queue.exists) {
    return queue.error ?? 'devteam control queue directory is missing; drain state is unobservable';
  }
  return queue.files.length === 0 ? null : `${queue.files.length} undrained devteam control block(s): ${queue.files.join(', ')}`;
}

/**
 * The supervisor drains the queue in the primary checkout, not in the
 * independently gitignored .devteam/ directory of a linked worktree.
 */
export function collectControlQueueEvidence(root) {
  const commonDirResult = command('git', ['rev-parse', '--git-common-dir'], root);
  const commonDir = commonDirResult.output.trim();
  if (commonDirResult.status !== 0 || !commonDir) {
    return {
      exists: false,
      files: [],
      error: 'cannot resolve git common directory; devteam control drain state is unobservable',
    };
  }

  const mainRoot = dirname(resolve(root, commonDir));
  const directory = join(mainRoot, '.devteam', 'control');
  return {
    directory,
    exists: existsSync(directory),
    files: existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith('.json')) : [],
  };
}

export function checkBuilderModels(config) {
  const active = config?.builders?.active;
  const defined = config?.builders?.defined;
  if (!Array.isArray(active) || !defined) return 'autopilot builder registry is unreadable';
  const missing = active.filter((unit) => typeof defined[unit]?.model !== 'string' || !defined[unit].model.trim());
  return missing.length === 0 ? null : `active builder model missing for: ${missing.join(', ')}`;
}

export function checkCoverageEvidence(result) {
  if (result.status !== 0) return 'packages/policy ordinary test run failed before emitting coverage';
  const uncoloured = result.output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
  if (!/% Coverage report from v8[\s\S]*All files/i.test(uncoloured)) {
    return 'packages/policy ordinary test run emitted no coverage report';
  }
  return null;
}

export function checkDistFreshness(packages) {
  const stale = [];
  for (const pkg of packages) {
    if (pkg.sourceFiles.length === 0) continue;
    if (pkg.distFiles.length === 0) {
      stale.push(`${pkg.name}: dist/ missing (${pkg.sourceFiles.length} source file(s))`);
      continue;
    }
    const latestSource = Math.max(...pkg.sourceFiles.map((file) => statSync(file).mtimeMs));
    const oldestDist = Math.min(...pkg.distFiles.map((file) => statSync(file).mtimeMs));
    if (oldestDist < latestSource) {
      stale.push(`${pkg.name}: dist/ is ${Math.ceil((latestSource - oldestDist) / 1000)}s behind src/`);
    }
  }
  return stale.length === 0 ? null : stale.join('; ');
}

function workspacePackages(root) {
  const roots = ['packages', 'services', 'apps'];
  return roots.flatMap((workspaceRoot) => {
    const directory = join(root, workspaceRoot);
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(directory, entry.name, 'package.json')))
      .map((entry) => {
        const path = join(directory, entry.name);
        return {
          name: relative(root, path),
          sourceFiles: walkFiles(join(path, 'src')),
          distFiles: walkFiles(join(path, 'dist')),
        };
      });
  });
}

function result(label, error) {
  return { label, status: error ? 1 : 0, detail: error ?? 'live evidence observed' };
}

export function livenessExitCode(checks) {
  return checks.some((check) => check.status !== 0) ? 1 : 0;
}

export function runLivenessChecks(root, supplied = {}) {
  const hook = supplied.hook ?? collectHookRejectionEvidence(root);
  const coverage = supplied.coverage ?? command('pnpm', ['--filter', '@oikonomos/policy', 'test'], root);
  const queued = supplied.queued ?? collectControlQueueEvidence(root);
  const config = supplied.config ?? JSON.parse(readFileSync(join(root, 'autopilot.json'), 'utf8'));
  const packages = supplied.packages ?? workspacePackages(root);
  return [
    result('territory pre-commit hook', checkHookEvidence(hook)),
    result('devteam control queue', checkControlQueue(queued)),
    result('active builder model pins', checkBuilderModels(config)),
    result('policy coverage collection', checkCoverageEvidence(coverage)),
    result('workspace dist freshness', checkDistFreshness(packages)),
  ];
}

function main() {
  const root = repoRoot();
  const checks = runLivenessChecks(root);
  for (const check of checks) {
    process.stdout.write(`controls-live: ${check.status === 0 ? 'PASS' : 'FAIL'} ${check.label} — ${check.detail}\n`);
  }
  process.exit(livenessExitCode(checks));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

#!/usr/bin/env node
/**
 * ADR-005 control-liveness gate.
 *
 * This checks evidence emitted by the controls themselves.  It deliberately
 * does not treat an mtime, a configured setting, or a successful no-op as
 * proof that a control is live.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot } from './lib/walk.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
function command(command, args, root) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
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

export function checkHookEvidence(result) {
  if (result.status !== 0) return 'territory pre-commit hook verifier rejected the installed hook';
  if (!/\[install-hooks\] installed:/i.test(result.output)) {
    return 'territory pre-commit hook verifier emitted no installed-hook evidence';
  }
  return null;
}

export function checkControlQueue(files) {
  return files.length === 0 ? null : `${files.length} undrained devteam control block(s): ${files.join(', ')}`;
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
  if (!/% Coverage report from v8[\s\S]*All files/i.test(result.output)) {
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
  const roots = ['packages', 'services'];
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
  const hook = supplied.hook ?? command('powershell', ['-ExecutionPolicy', 'Bypass', '-File', 'scripts/install_git_hooks.ps1', '-Verify'], root);
  const coverage = supplied.coverage ?? command('pnpm', ['--filter', '@oikonomos/policy', 'test'], root);
  const controlDirectory = join(root, '.devteam', 'control');
  const queued = supplied.queued ?? (existsSync(controlDirectory)
    ? readdirSync(controlDirectory).filter((name) => name.endsWith('.json'))
    : []);
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

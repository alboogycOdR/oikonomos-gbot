#!/usr/bin/env node
/**
 * OIK-003 protected-path review gate.
 *
 * GitHub CODEOWNERS becomes authoritative only after a remote and branch
 * protection are configured. Until then this script is the local, fail-closed
 * control: a protected diff must carry the explicit Fable approval marker.
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './lib/walk.mjs';

export const APPROVAL_MARKER = 'fable-reviewed';

export const PROTECTED_PATHS = Object.freeze([
  'packages/broker/**',
  'packages/policy/**',
  'packages/approvals/**',
  'packages/harness-factory/**',
  'infra/ci/**',
  'docs/decisions/**',
  '.claude/**',
  '.codex/**',
  'hooks/**',
  '.github/CODEOWNERS',
  '.github/workflows/**',
]);

function matches(path, pattern) {
  const expression = [...pattern].reduce((value, character, index, source) => {
    if (character !== '*') return value + character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    if (source[index + 1] === '*') return value;
    return source[index - 1] === '*' ? `${value}.*` : `${value}[^/]*`;
  }, '');
  return new RegExp(`^${expression}$`).test(path);
}

export function isProtectedPath(path) {
  return PROTECTED_PATHS.some((pattern) => matches(path, pattern));
}

export function changedPaths({ root = repoRoot(), base = 'HEAD' } = {}) {
  const result = spawnSync('git', ['diff', '--name-only', `${base}...HEAD`], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git diff exited ${result.status}`);
  }
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

export function checkProtectedPathReview({ paths, approvalMarker } = {}) {
  const protectedPaths = paths.filter(isProtectedPath);
  return {
    protectedPaths,
    approved: protectedPaths.length === 0 || approvalMarker === APPROVAL_MARKER,
  };
}

function parseArgs(argv) {
  const options = { root: repoRoot(), base: 'HEAD', approvalMarker: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') options.root = argv[++index];
    else if (argument === '--base') options.base = argv[++index];
    else if (argument === '--approval-marker') options.approvalMarker = argv[++index];
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`protected-path-review: ${error.message}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(
      'Usage: node infra/ci/protected-path-review.mjs --base <git-ref> [--approval-marker fable-reviewed]\n',
    );
    return 0;
  }

  let paths;
  try {
    paths = changedPaths(options);
  } catch (error) {
    process.stderr.write(`protected-path-review: cannot inspect diff: ${error.message}\n`);
    return 2;
  }
  const result = checkProtectedPathReview({ paths, approvalMarker: options.approvalMarker });
  if (result.approved) {
    process.stdout.write(
      result.protectedPaths.length === 0
        ? 'protected-path-review: clean diff (no protected paths)\n'
        : 'protected-path-review: protected diff carries Fable approval marker\n',
    );
    return 0;
  }

  process.stderr.write('protected-path-review: protected diff is missing the Fable approval marker\n');
  for (const path of result.protectedPaths) process.stderr.write(`  ${path}\n`);
  process.stderr.write(`Pass --approval-marker ${APPROVAL_MARKER} only after different-model Fable review.\n`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}

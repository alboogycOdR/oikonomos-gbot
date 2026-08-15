#!/usr/bin/env node
/**
 * Local mirror of .github/workflows/ci.yml.
 *
 * Root package.json is outside this task's territory (ORCH 15:15Z): call the
 * scripts TASK-001 already provides, plus `pnpm lint` if TASK-005 has added
 * it. Grep and secret-scan are invoked directly from this directory.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPROVAL_MARKER } from './protected-path-review.mjs';
import { repoRoot } from './lib/walk.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = repoRoot();

function run(label, command, args) {
  process.stdout.write(`\n==> ${label}: ${command} ${args.join(' ')}\n`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  return { label, status: result.status ?? 1, skipped: false };
}

function parseArgs(argv) {
  const options = { approvalMarker: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--approval-marker') {
      options.approvalMarker = argv[++index];
      if (!options.approvalMarker) throw new Error('--approval-marker requires a value');
      if (options.approvalMarker !== APPROVAL_MARKER) {
        throw new Error(`--approval-marker must be ${APPROVAL_MARKER}`);
      }
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function integrationMergeBase() {
  const integrationRef = ['master', 'main'].find((ref) => {
    const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], {
      cwd: root,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    return result.status === 0;
  });
  if (!integrationRef) {
    throw new Error('could not find local integration branch (master or main)');
  }
  const result = spawnSync('git', ['merge-base', 'HEAD', integrationRef], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || 'could not resolve merge-base with main');
  }
  const base = result.stdout.trim();
  if (!base) throw new Error('git merge-base returned no base commit');
  return { base, integrationRef };
}

function lintJob() {
  process.stdout.write('\n==> lint: pnpm lint\n');
  const probe = spawnSync('pnpm', ['lint'], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const combined = `${probe.stdout || ''}\n${probe.stderr || ''}`;
  const missing = /Command ["']lint["'] not found|Missing script:\s*lint/i.test(combined);
  if (missing) {
    process.stdout.write(
      'lint: not available yet (expected until TASK-005 merges `pnpm lint`). Noted, not treated as this job\'s defect.\n',
    );
    return { label: 'lint', status: 0, skipped: true };
  }
  if (probe.stdout) process.stdout.write(probe.stdout);
  if (probe.stderr) process.stderr.write(probe.stderr);
  return { label: 'lint', status: probe.status ?? 1, skipped: false };
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`run-local: ${error.message}\n`);
  process.exit(2);
}

if (options.help) {
  process.stdout.write(
    `Usage: node infra/ci/run-local.mjs [--approval-marker ${APPROVAL_MARKER}]\n`,
  );
  process.exit(0);
}

const jobs = [];
jobs.push(run('typecheck', 'pnpm', ['typecheck']));
jobs.push(run('build', 'pnpm', ['build']));
jobs.push(run('test', 'pnpm', ['test']));
jobs.push(lintJob());
jobs.push(run('banned-modes self-test', 'node', [join(here, 'test-banned-modes.mjs')]));
jobs.push(run('banned-modes', 'node', [join(here, 'banned-modes.mjs')]));
jobs.push(run('secret-scan self-test', 'node', [join(here, 'test-secret-scan.mjs')]));
jobs.push(run('secret-scan', 'node', [join(here, 'secret-scan.mjs')]));
jobs.push(run('protected-path-review self-test', 'node', [join(here, 'test-protected-path-review.mjs')]));
try {
  const { base, integrationRef } = integrationMergeBase();
  process.stdout.write(`protected-path-review: comparing HEAD with merge-base against ${integrationRef}\n`);
  const args = [join(here, 'protected-path-review.mjs'), '--base', base];
  if (options.approvalMarker) args.push('--approval-marker', options.approvalMarker);
  jobs.push(run('protected-path-review', 'node', args));
} catch (error) {
  process.stderr.write(`protected-path-review: cannot resolve local integration base: ${error.message}\n`);
  jobs.push({ label: 'protected-path-review', status: 1, skipped: false });
}

const failed = jobs.filter((j) => j.status !== 0);
process.stdout.write('\n==> local CI summary\n');
for (const job of jobs) {
  const mark = job.skipped ? 'SKIP' : job.status === 0 ? 'PASS' : 'FAIL';
  process.stdout.write(`  ${mark}  ${job.label}\n`);
}

if (failed.length > 0) {
  process.stderr.write(`local CI: ${failed.length} job(s) failed\n`);
  process.exit(1);
}

process.stdout.write('local CI: all runnable jobs green\n');

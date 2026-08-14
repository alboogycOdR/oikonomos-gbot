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

const jobs = [];
jobs.push(run('typecheck', 'pnpm', ['typecheck']));
jobs.push(run('build', 'pnpm', ['build']));
jobs.push(run('test', 'pnpm', ['test']));
jobs.push(lintJob());
jobs.push(run('banned-modes self-test', 'node', [join(here, 'test-banned-modes.mjs')]));
jobs.push(run('banned-modes', 'node', [join(here, 'banned-modes.mjs')]));
jobs.push(run('secret-scan self-test', 'node', [join(here, 'test-secret-scan.mjs')]));
jobs.push(run('secret-scan', 'node', [join(here, 'secret-scan.mjs')]));

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

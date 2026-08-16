/**
 * TASK-023 / ADR-005: the hosted `test` job and its local mirror must build
 * before they test. Workspace package `exports` point at gitignored `dist/`,
 * so `pnpm test` on a clean checkout cannot resolve `@oikonomos/*` unless a
 * build has already produced those files.
 *
 * This keys on the commands the workflow and runner will actually invoke, not
 * on a job named "build" existing in parallel (GitHub jobs do not share a
 * workspace unless `needs:` is set).
 */

const JOB_KEY = /^(\s*)([A-Za-z0-9_-]+):\s*(?:#.*)?$/;
const RUN_KEY = /^(\s+)(?:-\s+)?run:\s*(.*)$/;
const BLOCK_SCALAR = /^[|>][-+]?$/;
const PNPM_SCRIPT = /(?:^|[\s;&])pnpm(?:\s+-r)?\s+(build|test)(?=\s|$)/g;

/**
 * Collect `run:` step bodies from one GitHub Actions job.
 * Intentionally small: the workflow is a fixed two-space Actions file, not
 * arbitrary YAML. A parse miss fails closed (no run steps found).
 */
export function extractJobRunSteps(yamlText, jobName) {
  if (typeof yamlText !== 'string' || !yamlText) return [];
  const lines = yamlText.split(/\r?\n/);
  let jobsIndent = null;
  let inTarget = false;
  const runs = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '' || /^\s*#/.test(line)) continue;

    if (jobsIndent === null) {
      const jobs = line.match(/^(\s*)jobs:\s*(?:#.*)?$/);
      if (jobs) jobsIndent = jobs[1].length;
      continue;
    }

    const indent = line.match(/^(\s*)/)[1].length;
    if (indent <= jobsIndent) break;

    const key = line.match(JOB_KEY);
    if (key && indent === jobsIndent + 2) {
      inTarget = key[2] === jobName;
      continue;
    }
    if (!inTarget) continue;

    const run = line.match(RUN_KEY);
    if (!run) continue;
    const value = run[2].trim();
    if (BLOCK_SCALAR.test(value)) {
      const blockIndent = run[1].length;
      const block = [];
      for (let next = index + 1; next < lines.length; next += 1) {
        const body = lines[next];
        if (body.trim() === '') {
          block.push('');
          continue;
        }
        const bodyIndent = body.match(/^(\s*)/)[1].length;
        if (bodyIndent <= blockIndent) break;
        block.push(body.slice(blockIndent + 2));
        index = next;
      }
      runs.push(block.join('\n').trim());
    } else {
      runs.push(value.replace(/^['"]|['"]$/g, '').trim());
    }
  }
  return runs;
}

export function pnpmScriptsInRuns(runs) {
  const scripts = [];
  for (const body of runs) {
    PNPM_SCRIPT.lastIndex = 0;
    let match = PNPM_SCRIPT.exec(body);
    while (match) {
      scripts.push(match[1]);
      match = PNPM_SCRIPT.exec(body);
    }
  }
  return scripts;
}

function orderError(where, scripts) {
  const testAt = scripts.indexOf('test');
  const buildAt = scripts.indexOf('build');
  if (testAt === -1) {
    return `${where} does not invoke pnpm test`;
  }
  if (buildAt === -1) {
    return `${where} invokes pnpm test with no prior pnpm build; workspace exports point at gitignored dist/ and cannot resolve on a clean checkout`;
  }
  if (buildAt > testAt) {
    return `${where} invokes pnpm test before pnpm build (pnpm scripts: ${scripts.join(', ')})`;
  }
  return null;
}

export function checkWorkflowTestJobOrder(yamlText) {
  const runs = extractJobRunSteps(yamlText, 'test');
  if (runs.length === 0) {
    return 'CI workflow has no test job with run steps; test-job build order is unobservable';
  }
  return orderError('CI test job', pnpmScriptsInRuns(runs));
}

/**
 * Evidence that the local mirror still calls `pnpm build` before `pnpm test`.
 * Matches the `run(label, 'pnpm', ['script'])` calls run-local actually makes.
 */
export function checkRunLocalTestJobOrder(source) {
  if (typeof source !== 'string' || !source) {
    return 'run-local.mjs source is unreadable; test-job build order is unobservable';
  }
  const calls = [];
  const call = /run\(\s*(['"])([^'"]+)\1\s*,\s*(['"])pnpm\3\s*,\s*\[\s*(['"])(build|test)\4\s*\]/g;
  let match = call.exec(source);
  while (match) {
    calls.push(match[5]);
    match = call.exec(source);
  }
  return orderError('run-local.mjs', calls);
}

export function checkTestJobBuildOrder({ workflow, runLocal } = {}) {
  return checkWorkflowTestJobOrder(workflow) ?? checkRunLocalTestJobOrder(runLocal);
}

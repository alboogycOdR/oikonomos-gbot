#!/usr/bin/env node
/**
 * Self-tests for OIK-004 / CAN-03.
 * Proves: allowlist is ADR-002 Amendment A; enforcement surfaces catch;
 * prose surfaces do not; a packages/ fixture fails; the current repo passes.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { bannedTokens, scanBannedModes } from './banned-modes.mjs';
import {
  ENFORCEMENT_SURFACES,
  TOKEN_PINS,
  isAllowlisted,
  isEnforcementSurface,
  loadAllowlist,
  matchPath,
} from './lib/allowlist.mjs';
import {
  FALLBACK_SKIP_DIRS,
  gitIgnoredPaths,
  isInsideGitWorkTree,
  relPosix,
  resolveIgnoreMode,
  walkFiles,
} from './lib/walk.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const allowlistPath = join(here, 'banned-modes-allowlist.txt');

const EXPECTED_ALLOWLIST = [
  'docs/**',
  'specs/**',
  'dossiers/**',
  'briefings/**',
  '.claude/commands/**',
  'PLAN.md',
  'REVIEW.md',
  'AUTOPILOT_LOG.md',
  'INSTINCTS.md',
  '*.md',
  'autopilot.json',
  'scripts/**',
];

const EXPECTED_ENFORCEMENT = [
  'packages/**',
  'apps/**',
  'services/**',
  'infra/**',
  'evals/**',
  '.github/**',
  '.claude/settings*.json',
  '.claude/agents/**',
  '.codex/**',
];

test('allowlist cites ADR-002 Amendment A and is the prose + §2(2) set', () => {
  const raw = readFileSync(allowlistPath, 'utf8');
  assert.match(raw, /ADR-002/);
  assert.match(raw, /Amendment A/);
  assert.match(raw, /docs\/decisions\/ADR-002-permission-bypass-ban-scope\.md/);
  assert.deepEqual(loadAllowlist(allowlistPath), EXPECTED_ALLOWLIST);
  assert.deepEqual([...ENFORCEMENT_SURFACES], EXPECTED_ENFORCEMENT);
});

test('path globs: root *.md and settings*.json do not leak into nested dirs', () => {
  assert.equal(matchPath('PLAN.md', '*.md'), true);
  assert.equal(matchPath('DEVDEPARTMENT_HANDOVER_PROMPT.md', '*.md'), true);
  assert.equal(matchPath('docs/architecture/note.md', '*.md'), false);
  assert.equal(matchPath('.claude/settings.json', '.claude/settings*.json'), true);
  assert.equal(matchPath('.claude/settings.local.json', '.claude/settings*.json'), true);
  assert.equal(matchPath('.claude/agents/settings.json', '.claude/settings*.json'), false);
  assert.equal(isEnforcementSurface('packages/broker/src/index.ts'), true);
  assert.equal(isEnforcementSurface('.claude/settings.json'), true);
  assert.equal(isEnforcementSurface('.claude/commands/devteam-review.md'), false);
  assert.equal(isAllowlisted('specs/foo.md', EXPECTED_ALLOWLIST), true);
  assert.equal(isAllowlisted('packages/broker/src/index.ts', EXPECTED_ALLOWLIST), false);
});

test('each banned token in a temp packages/ path fails the scan', () => {
  const tokens = bannedTokens();
  assert.equal(tokens.length, 8);

  const root = mkdtempSync(join(tmpdir(), 'oik-banned-'));
  try {
    const pkgDir = join(root, 'packages', 'policy', 'src');
    mkdirSync(pkgDir, { recursive: true });
    const planted = join(pkgDir, 'violation.ts');

    for (const token of tokens) {
      writeFileSync(planted, `// mode: ${token}\n`, 'utf8');
      const { violations } = scanBannedModes({ root, allowlistPath });
      assert.ok(
        violations.some((v) => v.token === token && v.file === 'packages/policy/src/violation.ts'),
        `expected to catch ${token} under packages/`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('enforcement surfaces catch even when someone lists them as carve-outs', () => {
  const token = bannedTokens()[0];
  const root = mkdtempSync(join(tmpdir(), 'oik-banned-enf-'));
  const override = join(root, 'override-allowlist.txt');
  try {
    writeFileSync(
      override,
      ['packages/**', 'apps/**', '.github/**', '.claude/agents/**', 'infra/**'].join('\n'),
      'utf8',
    );

    const planted = [
      ['packages/broker/src/bad.ts', 'packages/broker/src/bad.ts'],
      ['apps/dashboard/src/bad.ts', 'apps/dashboard/src/bad.ts'],
      ['.github/workflows/bad.yml', '.github/workflows/bad.yml'],
      ['.claude/settings.json', '.claude/settings.json'],
      ['.claude/settings.local.json', '.claude/settings.local.json'],
      ['.claude/agents/rogue.md', '.claude/agents/rogue.md'],
      ['infra/ci/bad.mjs', 'infra/ci/bad.mjs'],
      ['services/worker/src/bad.ts', 'services/worker/src/bad.ts'],
      ['evals/canary/bad.ts', 'evals/canary/bad.ts'],
    ];

    for (const [rel] of planted) {
      mkdirSync(join(root, dirname(rel)), { recursive: true });
      writeFileSync(join(root, rel), `mentions ${token}\n`, 'utf8');
    }

    const { violations } = scanBannedModes({ root, allowlistPath: override });
    for (const [, expected] of planted) {
      assert.ok(
        violations.some((v) => v.file === expected && v.token === token),
        `expected enforcement catch at ${expected}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Amendment A prose and §2(2) surfaces are not violations', () => {
  const token = bannedTokens()[0];
  const root = mkdtempSync(join(tmpdir(), 'oik-banned-prose-'));
  try {
    const prose = [
      'docs/decisions/note.md',
      'specs/directive.md',
      'dossiers/TASK-004.md',
      'briefings/GROK_BUILD_BRIEFING.md',
      '.claude/commands/devteam-review.md',
      'PLAN.md',
      'REVIEW.md',
      'AUTOPILOT_LOG.md',
      'INSTINCTS.md',
      'CLAUDE.md',
      'DEVDEPARTMENT_HANDOVER_PROMPT.md',
      'autopilot.json',
      'scripts/dispatch.sh',
    ];
    mkdirSync(join(root, 'packages', 'broker', 'src'), { recursive: true });
    for (const rel of prose) {
      mkdirSync(join(root, dirname(rel)), { recursive: true });
      writeFileSync(join(root, rel), `mentions ${token}\n`, 'utf8');
    }
    writeFileSync(join(root, 'packages', 'broker', 'src', 'ok.ts'), 'export const x = 1;\n', 'utf8');

    const { violations } = scanBannedModes({ root, allowlistPath });
    assert.deepEqual(violations, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Codex bypass-vocabulary tokens (TASK-295) are caught on enforcement surfaces, both flag forms', () => {
  // ADR-002 Amendment B residual risk (d): CAN-03's token list tracked only
  // Claude Code vocabulary. Codex's short/long sandbox-escalation flags and
  // its separate "dangerously bypass approvals and sandbox" flag (see
  // banned-modes.mjs's header comment and scripts/dispatch.ps1/.sh for the
  // exact literals) are the functional equivalent and must be caught too.
  const tokens = bannedTokens();
  const codexTokens = [
    ['-s ', 'danger-full-access'].join(''),
    ['--sandbox ', 'danger-full-access'].join(''),
    ['--dangerously-bypass-approvals-and-', 'sandbox'].join(''),
  ];
  for (const t of codexTokens) assert.ok(tokens.includes(t), `expected bannedTokens() to include ${t}`);

  const root = mkdtempSync(join(tmpdir(), 'oik-banned-codex-'));
  try {
    const pkgDir = join(root, 'packages', 'harness-factory', 'src');
    mkdirSync(pkgDir, { recursive: true });
    const planted = join(pkgDir, 'violation.ts');

    for (const token of codexTokens) {
      writeFileSync(planted, `// spawn(['codex', 'exec', ${JSON.stringify(token)}])\n`, 'utf8');
      const { violations } = scanBannedModes({ root, allowlistPath });
      assert.ok(
        violations.some((v) => v.token === token && v.file === 'packages/harness-factory/src/violation.ts'),
        `expected to catch Codex bypass token "${token}" under packages/`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Codex bypass-vocabulary tokens do not fire on Amendment A prose surfaces', () => {
  const codexTokens = [
    ['-s ', 'danger-full-access'].join(''),
    ['--sandbox ', 'danger-full-access'].join(''),
    ['--dangerously-bypass-approvals-and-', 'sandbox'].join(''),
  ];
  const root = mkdtempSync(join(tmpdir(), 'oik-banned-codex-prose-'));
  try {
    mkdirSync(join(root, 'docs', 'decisions'), { recursive: true });
    mkdirSync(join(root, 'dossiers'), { recursive: true });
    const lines = codexTokens.map((t) => `mentions ${t}`).join('\n');
    writeFileSync(join(root, 'docs', 'decisions', 'ADR-002-permission-bypass-ban-scope.md'), lines, 'utf8');
    writeFileSync(join(root, 'dossiers', 'TASK-295.md'), lines, 'utf8');

    const { violations } = scanBannedModes({ root, allowlistPath });
    assert.deepEqual(violations, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a bare CodexSandbox enum value (no flag) is NOT flagged -- guards packages/agent-providers real use', () => {
  // packages/agent-providers/src/config.ts and providers/codex.ts declare
  // "danger-full-access" as one of three legitimate, broker-gated sandbox
  // enum values (ADR-011). The Codex tokens must be flag+value compounds,
  // never the bare value alone, or this real reviewed feature would trip
  // the scanner and break "current repo passes clean".
  const root = mkdtempSync(join(tmpdir(), 'oik-banned-bare-value-'));
  try {
    const pkgDir = join(root, 'packages', 'agent-providers', 'src');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'config.ts'),
      'export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";\n',
      'utf8',
    );
    const { violations } = scanBannedModes({ root, allowlistPath });
    assert.deepEqual(violations, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const AA = ['--always-', 'approve'].join('');
const SBXV = ['danger-full-', 'access'].join('');
const KEY = (q = '"') => `sandbox_mode = ${q}${SBXV}${q}`;
const CODEX_PIN_TEXT = [`# note: codex exec -s ${SBXV}`, KEY(), '[profiles.builder]', KEY(), ''].join('\n');
const GROK_PATH = 'packages/agent-providers/src/providers/grok.ts';
const GROK_TEXT = [`// passes \`${AA}\``, `args.push("${AA}");`, ''].join('\n');

function withRoot(files, fn) {
  const root = mkdtempSync(join(tmpdir(), 'oik-banned-pin-'));
  try {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text, 'utf8');
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('Codex config-key form is banned, tolerant of whitespace and quote style, on .codex/**', () => {
  assert.ok(bannedTokens().includes(KEY()));
  assert.ok(isEnforcementSurface('.codex/config.toml'));
  for (const text of [KEY(), KEY("'"), `sandbox_mode=${'"'}${SBXV}${'"'}`, `sandbox_mode   =   "${SBXV}"`]) {
    const { violations } = withRoot({ '.codex/other.toml': `${text}\n` }, (root) => scanBannedModes({ root, allowlistPath }));
    assert.equal(violations.length, 1, `expected a hit for: ${text}`);
  }
  // other sandbox values are fine
  const { violations } = withRoot({ '.codex/other.toml': 'sandbox_mode = "workspace-write"\n' }, (root) =>
    scanBannedModes({ root, allowlistPath }),
  );
  assert.deepEqual(violations, []);
  // flag long form with = also caught
  const eq = withRoot({ 'infra/x.sh': `codex --sandbox=${SBXV}\n` }, (root) => scanBannedModes({ root, allowlistPath }));
  assert.equal(eq.violations.length, 1);
});

test('.codex/config.toml pin: exact current count passes; a planted extra profile fails; a lowered count fails', () => {
  const run = (text) => withRoot({ '.codex/config.toml': text }, (root) => scanBannedModes({ root, allowlistPath }).violations);
  assert.deepEqual(run(CODEX_PIN_TEXT), []);
  // growth (new profile) rejected
  assert.ok(run(`${CODEX_PIN_TEXT}[profiles.new]\n${KEY()}\n`).length > 0);
  // shrink without lowering the pin rejected
  assert.ok(run([`# note: codex exec -s ${SBXV}`, KEY(), ''].join('\n')).length > 0);
  // same count but on a different file is not exempt
  const other = withRoot({ '.codex/other.toml': CODEX_PIN_TEXT }, (root) => scanBannedModes({ root, allowlistPath }).violations);
  assert.ok(other.length > 0);
});

test('.codex pin cannot be widened via the allowlist file: an allowlist line does not override the enforcement surface', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oik-banned-al-'));
  try {
    const al = join(dir, 'al.txt');
    writeFileSync(al, '.codex/**\n', 'utf8');
    const v = withRoot({ '.codex/other.toml': `${KEY()}\n` }, (root) => scanBannedModes({ root, allowlistPath: al }).violations);
    assert.equal(v.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the real repo pin registry is exactly the measured set and the real files match it', () => {
  const summary = TOKEN_PINS.map((p) => `${p.file}|${p.token}|${p.count}`).sort();
  assert.equal(summary.length, 3);
  for (const p of TOKEN_PINS) {
    const text = readFileSync(join(here, '..', '..', p.file), 'utf8');
    const { violations } = scanBannedModes({ allowlistPath, pins: [] });
    const actual = violations.filter((v) => v.file === p.file && v.token === p.token).length;
    assert.equal(actual, p.count, `${p.file} ${p.token}`);
    assert.ok(text.length > 0);
  }
});

test('Grok always-approve is a banned token; one pinned exemption in grok.ts; elsewhere and a third occurrence fail', () => {
  assert.ok(bannedTokens().includes(AA));
  const run = (files) => withRoot(files, (root) => scanBannedModes({ root, allowlistPath }).violations);
  assert.deepEqual(run({ [GROK_PATH]: GROK_TEXT }), []);
  assert.ok(run({ [GROK_PATH]: `${GROK_TEXT}args.push("${AA}");\n` }).length > 0);
  assert.ok(run({ [GROK_PATH]: `// only one ${AA}\n` }).length > 0);
  assert.equal(run({ 'packages/agent-providers/src/providers/other.ts': GROK_TEXT }).length, 2);
  assert.equal(run({ '.github/workflows/x.yml': `run: grok ${AA}\n` }).length, 1);
});

test('a bare CodexSandbox enum value beside a pinned grok.ts is still not flagged', () => {
  const v = withRoot(
    { [GROK_PATH]: GROK_TEXT, 'packages/agent-providers/src/config.ts': `type S = "${SBXV}";\n` },
    (root) => scanBannedModes({ root, allowlistPath }).violations,
  );
  assert.deepEqual(v, []);
});

test('current repo has no hits outside the ADR-002 Amendment A allowlist', () => {
  const { violations } = scanBannedModes({ allowlistPath });
  assert.deepEqual(
    violations,
    [],
    violations.map((v) => `${v.file}:${v.line}:${v.token}`).join('\n'),
  );
});

test('tracked enforcement violation is still caught; gitignored twin is skipped by check-ignore', () => {
  const token = bannedTokens()[0];
  const root = mkdtempSync(join(tmpdir(), 'oik-banned-gi-'));
  try {
    const init = spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    spawnSync('git', ['config', 'user.email', 'ci@example.test'], { cwd: root });
    spawnSync('git', ['config', 'user.name', 'ci'], { cwd: root });

    // local-scratch/ is gitignored. It sits under packages/** (enforcement
    // surface) so Amendment A would NOT carve it out — skip must be gitignore.
    writeFileSync(join(root, '.gitignore'), 'local-scratch/\n', 'utf8');
    mkdirSync(join(root, 'packages', 'policy', 'src'), { recursive: true });
    mkdirSync(join(root, 'packages', 'local-scratch'), { recursive: true });

    const trackedRel = 'packages/policy/src/tracked-violation.ts';
    const ignoredRel = 'packages/local-scratch/ignored-violation.ts';
    writeFileSync(join(root, trackedRel), `export const mode = ${JSON.stringify(token)};\n`, 'utf8');
    writeFileSync(join(root, ignoredRel), `export const mode = ${JSON.stringify(token)};\n`, 'utf8');

    assert.equal(isEnforcementSurface(ignoredRel), true, 'ignored path is still an enforcement surface');
    assert.equal(
      isAllowlisted(ignoredRel, loadAllowlist(allowlistPath)),
      false,
      'skip must not be explainable as an allowlist carve-out',
    );
    assert.equal(isInsideGitWorkTree(root), true);
    assert.equal(resolveIgnoreMode(root).mode, 'git');
    assert.ok(
      gitIgnoredPaths(root, [ignoredRel]).has(ignoredRel),
      'git check-ignore must report the planted ignored path',
    );
    assert.equal(gitIgnoredPaths(root, [trackedRel]).has(trackedRel), false);

    const walked = new Set(walkFiles(root).map((abs) => relPosix(root, abs)));
    assert.ok(walked.has(trackedRel), 'tracked enforcement file must remain in the walk');
    assert.equal(walked.has(ignoredRel), false, 'gitignored file must be omitted from the walk');

    const { violations } = scanBannedModes({ root, allowlistPath });
    assert.ok(
      violations.some((v) => v.file === trackedRel && v.token === token),
      'tracked enforcement violation must still be caught',
    );
    assert.equal(
      violations.some((v) => v.file === ignoredRel),
      false,
      'gitignored enforcement path must not surface as a violation',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fallback skip-list omits .devteam when git is unavailable (not an allowlist carve-out)', () => {
  const token = bannedTokens()[0];
  const root = mkdtempSync(join(tmpdir(), 'oik-banned-fb-'));
  try {
    assert.equal(isInsideGitWorkTree(root), false);
    assert.equal(resolveIgnoreMode(root).mode, 'fallback');
    assert.ok(FALLBACK_SKIP_DIRS.has('.devteam'));

    mkdirSync(join(root, 'packages', 'broker', 'src'), { recursive: true });
    mkdirSync(join(root, '.devteam', 'runs'), { recursive: true });
    const trackedRel = 'packages/broker/src/tracked.ts';
    const noiseRel = '.devteam/runs/session.log';
    writeFileSync(join(root, trackedRel), `export const mode = ${JSON.stringify(token)};\n`, 'utf8');
    writeFileSync(join(root, noiseRel), `mentions ${token}\n`, 'utf8');

    assert.equal(isEnforcementSurface(noiseRel), false);
    assert.equal(
      isAllowlisted(noiseRel, loadAllowlist(allowlistPath)),
      false,
      '.devteam is not an Amendment A prose carve-out; fallback skip is independent',
    );

    const walked = new Set(walkFiles(root).map((abs) => relPosix(root, abs)));
    assert.ok(walked.has(trackedRel));
    assert.equal(walked.has(noiseRel), false);

    const { violations } = scanBannedModes({ root, allowlistPath });
    assert.ok(violations.some((v) => v.file === trackedRel && v.token === token));
    assert.equal(violations.some((v) => v.file === noiseRel), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

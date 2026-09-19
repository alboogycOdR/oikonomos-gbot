#!/usr/bin/env node
/**
 * OIK-004 / CAN-03 banned-mode grep.
 *
 * Implements ADR-002 Amendment A: scan the repo for the banned
 * permission-mode tokens; fail the build on any hit outside the prose /
 * dev-tooling carve-out. Enforcement surfaces (packages/**, apps/**,
 * services/**, infra/**, evals/**, .github/**, .claude/settings*.json,
 * .claude/agents/**) are never skipped. The allowlist lives beside this
 * file and cites ADR-002 Amendment A.
 *
 * Tokens are assembled at runtime. ADR-002 §1 forbids those literals under
 * infra/** (this path), so this source must never contain them contiguously.
 *
 * Non-Claude CLI vocabulary (TASK-295, closing ADR-002 Amendment B residual
 * risk (d)): the first three tokens below are Claude Code's own bypass
 * vocabulary. The Codex tokens that follow are its functional equivalent —
 * see scripts/dispatch.ps1 / dispatch.sh for CX's exact live invocation, and
 * `codex exec --help` (confirmed against the installed CLI) for the full
 * flag surface: the short `-s` and long `--sandbox` forms both take the
 * highest-privilege sandbox value as their argument, and a separate,
 * stronger flag skips approvals and sandboxing outright ("dangerously
 * bypass approvals and sandbox"). Both flag forms are matched as the flag
 * *and* its value TOGETHER, never the value alone: that value on its own is
 * also a legitimate CodexSandbox enum member declared by
 * `packages/agent-providers` (config.ts, codex.ts) for its own broker-gated,
 * user-selectable sandbox setting (ADR-011) — a bare-value token would flag
 * that real, reviewed product feature and break "current repo passes clean".
 *
 * Config-file key form (TASK-295 ORCH decision A): Codex's config.toml can
 * set the same bypass via its `sandbox_mode` key with the top sandbox value, which no CLI
 * flag token matches; it is matched by regex, tolerant of whitespace and
 * quote style.
 *
 * Grok Build's always-approve flag ("Auto-approve all tool executions") is a
 * banned token too. Unlike the Codex flags it has no value to pair with, and
 * reviewed product code legitimately constructs it, so both it and the Codex
 * config occurrences are handled by COUNT-PINNED exemptions (TOKEN_PINS in
 * lib/allowlist.mjs): keyed on (exact file, exact token) with an exact
 * expected hit count, in code rather than the free-text allowlist. The pin
 * fails in EITHER direction, so growth is rejected and a removed occurrence
 * forces the pin down. Residual: a genuine bypass added inside a pinned file
 * is caught only through the count change. See ADR-002 Amendment B (d) and
 * ADR-011 (grok.ts); dossiers/TASK-295.md carries the Amendment C text.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TOKEN_PINS, isAllowlisted, loadAllowlist } from './lib/allowlist.mjs';
import { relPosix, repoRoot, walkFiles } from './lib/walk.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const SBX = ['danger-full-', 'access'].join('');

// [display token, matcher]. Display strings are what violations report.
function tokenSpecs() {
  return [
    ['bypass', 'Permissions'].join(''),
    ['accept', 'Edits'].join(''),
    ['--dangerously-skip-', 'permissions'].join(''),
    ['-s ', SBX].join(''),
    ['--sandbox ', SBX].join(''),
    ['--dangerously-bypass-approvals-and-', 'sandbox'].join(''),
    ['sandbox_mode = "', SBX, '"'].join(''),
    ['--always-', 'approve'].join(''),
  ].map((token) => {
    let re;
    if (token.startsWith('-s ')) re = new RegExp(`-s\\s+${SBX}`, 'g');
    else if (token.startsWith('--sandbox ')) re = new RegExp(`--sandbox[\\s=]+${SBX}`, 'g');
    else if (token.startsWith('sandbox_mode')) re = new RegExp(`sandbox_mode\\s*=\\s*["']${SBX}["']`, 'g');
    else re = new RegExp(token.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&'), 'g');
    return { token, re };
  });
}

export function bannedTokens() {
  return tokenSpecs().map((t) => t.token);
}

export function scanBannedModes({
  root = repoRoot(),
  allowlistPath = join(here, 'banned-modes-allowlist.txt'),
  extraFiles = [],
  pins = TOKEN_PINS,
} = {}) {
  const specs = tokenSpecs();
  const tokens = specs.map((t) => t.token);
  const allowlist = loadAllowlist(allowlistPath);
  const files = new Set(walkFiles(root));
  for (const extra of extraFiles) files.add(extra);

  const hits = [];
  for (const abs of files) {
    const rel = relPosix(root, abs);
    if (rel.startsWith('..')) continue;
    if (isAllowlisted(rel, allowlist)) continue;

    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }

    const lines = text.split(/\r?\n/);
    for (const { token, re } of specs) {
      for (let i = 0; i < lines.length; i += 1) {
        const n = (lines[i].match(re) ?? []).length;
        for (let k = 0; k < n; k += 1) hits.push({ file: rel, line: i + 1, token });
      }
    }
  }

  // Count-pinned exemptions: exact (file, token) with an exact expected count.
  const violations = [];
  const pinned = new Map(pins.map((p) => [`${p.file}|${p.token}`, p]));
  const counts = new Map();
  for (const hit of hits) {
    const key = `${hit.file}|${hit.token}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const hit of hits) {
    const key = `${hit.file}|${hit.token}`;
    const pin = pinned.get(key);
    if (pin && counts.get(key) === pin.count) continue;
    violations.push(
      pin
        ? { ...hit, note: `pin mismatch: ${counts.get(key)} hit(s), pinned ${pin.count} (${pin.adr})` }
        : hit,
    );
  }
  // A pin whose occurrences vanished is stale; only checkable on the real repo tree.
  if (resolve(root) === resolve(repoRoot())) {
    for (const pin of pins) {
      if (!counts.has(`${pin.file}|${pin.token}`)) {
        violations.push({
          file: pin.file,
          line: 0,
          token: pin.token,
          note: `stale pin: 0 hit(s), pinned ${pin.count} (${pin.adr})`,
        });
      }
    }
  }

  return { tokens, allowlist, violations };
}

function parseArgs(argv) {
  const opts = { root: repoRoot(), extraFiles: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      opts.root = argv[++i];
    } else if (arg === '--allowlist') {
      opts.allowlistPath = argv[++i];
    } else if (arg === '--extra-file') {
      opts.extraFiles.push(argv[++i]);
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`banned-modes: ${err.message}\n`);
    return 2;
  }

  if (opts.help) {
    process.stdout.write(
      'Usage: node infra/ci/banned-modes.mjs [--root DIR] [--allowlist FILE] [--extra-file PATH]\n',
    );
    return 0;
  }

  const { violations } = scanBannedModes(opts);
  if (violations.length === 0) {
    process.stdout.write('banned-modes: clean (no hits outside ADR-002 allowlist)\n');
    return 0;
  }

  process.stderr.write(
    `banned-modes: ${violations.length} hit(s) outside the ADR-002 allowlist\n`,
  );
  for (const hit of violations) {
    process.stderr.write(`  ${hit.file}:${hit.line}: ${hit.token}${hit.note ? ` [${hit.note}]` : ''}\n`);
  }
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}

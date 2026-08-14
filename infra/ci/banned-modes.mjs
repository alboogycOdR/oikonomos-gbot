#!/usr/bin/env node
/**
 * OIK-004 / CAN-03 banned-mode grep.
 *
 * Implements ADR-002 Amendment A: scan the repo for the three banned
 * permission-mode tokens; fail the build on any hit outside the prose /
 * dev-tooling carve-out. Enforcement surfaces (packages/**, apps/**,
 * services/**, infra/**, evals/**, .github/**, .claude/settings*.json,
 * .claude/agents/**) are never skipped. The allowlist lives beside this
 * file and cites ADR-002 Amendment A.
 *
 * Tokens are assembled at runtime. ADR-002 §1 forbids those literals under
 * infra/** (this path), so this source must never contain them contiguously.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAllowlisted, loadAllowlist } from './lib/allowlist.mjs';
import { relPosix, repoRoot, walkFiles } from './lib/walk.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export function bannedTokens() {
  return [
    ['bypass', 'Permissions'].join(''),
    ['accept', 'Edits'].join(''),
    ['--dangerously-skip-', 'permissions'].join(''),
  ];
}

export function scanBannedModes({
  root = repoRoot(),
  allowlistPath = join(here, 'banned-modes-allowlist.txt'),
  extraFiles = [],
} = {}) {
  const tokens = bannedTokens();
  const allowlist = loadAllowlist(allowlistPath);
  const files = new Set(walkFiles(root));
  for (const extra of extraFiles) files.add(extra);

  const violations = [];
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

    for (const token of tokens) {
      if (!text.includes(token)) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i].includes(token)) continue;
        violations.push({ file: rel, line: i + 1, token });
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
    process.stderr.write(`  ${hit.file}:${hit.line}: ${hit.token}\n`);
  }
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}

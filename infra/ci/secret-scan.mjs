#!/usr/bin/env node
/**
 * OIK-007 secret scan (CI job + pre-commit).
 *
 * Fails closed on known credential patterns. Patterns are assembled from
 * fragments so this source never contains a credential-shaped literal
 * (N4; the DEVDEPARTMENT PreToolUse hook blocks realistic writes).
 *
 * Test fixtures must be obviously fake and contain PLACEHOLDER text.
 *
 * ADR-002 Amendment A: exempt exactly `hooks/run-tests.js` (the pack's
 * own detector corpus). One named file, never a glob.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { relPosix, repoRoot, walkFiles } from './lib/walk.mjs';

/** Single named exemption — ADR-002 Amendment A. Not a glob. */
export const SECRET_SCAN_EXEMPT_FILES = Object.freeze(['hooks/run-tests.js']);

function isSecretExempt(relPath) {
  const norm = relPath.replace(/\\/g, '/');
  return SECRET_SCAN_EXEMPT_FILES.includes(norm);
}

export function secretPatterns() {
  const openAi = ['sk', '-[A-Za-z0-9_-]{16,}'].join('');
  const github = ['gh', '[pousr]_[A-Za-z0-9]{20,}'].join('');
  const aws = ['AKIA', '[0-9A-Z]{16}'].join('');
  const google = ['AIza', '[0-9A-Za-z_-]{30,}'].join('');
  const slack = ['xox', '[baprs]-[A-Za-z0-9-]{10,}'].join('');
  const pem = ['-----BEGIN ', '(?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----'].join('');
  const telegram = ['\\d{8,10}:', 'AA[A-Za-z0-9_-]{30,}'].join('');

  return [
    { name: 'OpenAI/Anthropic-style API key', re: new RegExp(String.raw`\b${openAi}\b`) },
    { name: 'GitHub token', re: new RegExp(String.raw`\b${github}\b`) },
    { name: 'AWS access key ID', re: new RegExp(String.raw`\b${aws}\b`) },
    { name: 'Google API key', re: new RegExp(String.raw`\b${google}\b`) },
    { name: 'Slack token', re: new RegExp(String.raw`\b${slack}\b`) },
    { name: 'Private key block', re: new RegExp(pem) },
    { name: 'Telegram bot token', re: new RegExp(String.raw`\b${telegram}\b`) },
  ];
}

export function fakePlaceholderKey() {
  return ['sk', 'PLACEHOLDER_FAKE_NOT_A_REAL_SECRET'].join('-');
}

export function findSecretHits(text, patterns = secretPatterns()) {
  if (!text) return [];
  const hits = [];
  for (const { name, re } of patterns) {
    re.lastIndex = 0;
    if (re.test(text)) hits.push(name);
  }
  return hits;
}

function stagedFiles(root) {
  const listed = spawnSync(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'],
    { cwd: root, encoding: 'utf8' },
  );
  if (listed.status !== 0) {
    throw new Error(listed.stderr || 'git diff --cached failed');
  }
  return listed.stdout.split('\0').filter(Boolean);
}

function stagedContent(root, rel) {
  const shown = spawnSync('git', ['show', `:${rel}`], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (shown.status !== 0) {
    throw new Error(shown.stderr || `git show :${rel} failed`);
  }
  return shown.stdout;
}

export function scanSecrets({
  root = repoRoot(),
  files = null,
  staged = false,
} = {}) {
  const patterns = secretPatterns();
  const findings = [];

  if (staged) {
    for (const rel of stagedFiles(root)) {
      const posix = rel.replace(/\\/g, '/');
      if (isSecretExempt(posix)) continue;
      let text;
      try {
        text = stagedContent(root, rel);
      } catch {
        continue;
      }
      const hits = findSecretHits(text, patterns);
      if (hits.length > 0) findings.push({ file: posix, hits });
    }
    return findings;
  }

  const targets = files && files.length > 0 ? files.map((f) => resolve(f)) : walkFiles(root);
  for (const abs of targets) {
    const rel = relPosix(root, abs);
    if (rel.startsWith('..') && !(files && files.length > 0)) continue;
    if (isSecretExempt(rel)) continue;
    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const hits = findSecretHits(text, patterns);
    if (hits.length > 0) findings.push({ file: rel.replace(/\\/g, '/'), hits });
  }
  return findings;
}

function parseArgs(argv) {
  const opts = { root: repoRoot(), files: [], staged: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      opts.root = argv[++i];
    } else if (arg === '--staged') {
      opts.staged = true;
    } else if (arg === '--files') {
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        opts.files.push(argv[++i]);
      }
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
    process.stderr.write(`secret-scan: ${err.message}\n`);
    return 2;
  }

  if (opts.help) {
    process.stdout.write(
      'Usage: node infra/ci/secret-scan.mjs [--root DIR] [--staged] [--files PATH...]\n',
    );
    return 0;
  }

  let findings;
  try {
    findings = scanSecrets(opts);
  } catch (err) {
    process.stderr.write(`secret-scan: ${err.message}\n`);
    return 2;
  }

  if (findings.length === 0) {
    process.stdout.write('secret-scan: clean (no known secret patterns)\n');
    return 0;
  }

  process.stderr.write(`secret-scan: ${findings.length} file(s) matched known secret patterns\n`);
  for (const finding of findings) {
    process.stderr.write(`  ${finding.file}: ${finding.hits.join('; ')}\n`);
  }
  process.stderr.write(
    'secret-scan: refuse to merge. Use environment variables or a secret manager; fixtures must contain PLACEHOLDER text and never look real (N4).\n',
  );
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}

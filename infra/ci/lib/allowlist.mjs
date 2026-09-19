import { readFileSync } from 'node:fs';

/**
 * ADR-002 Amendment A enforcement surfaces. Scanned with no exceptions:
 * a carve-out entry cannot override these (a token here is a live grant).
 */
export const ENFORCEMENT_SURFACES = Object.freeze([
  'packages/**',
  'apps/**',
  'services/**',
  'infra/**',
  'evals/**',
  '.github/**',
  '.claude/settings*.json',
  '.claude/agents/**',
  '.codex/**',
]);

/**
 * Count-pinned token exemptions (TASK-295; ADR-002 Amendment B residual (d)).
 * Keyed on (exact file, exact token) with the exact expected hit count. They
 * live in code, not the free-text allowlist, so they cannot be widened by an
 * allowlist line, and the scanner fails when the actual count differs in
 * EITHER direction (growth rejected; a removed occurrence forces the pin
 * down). Tokens are the display strings from banned-modes.mjs.
 */
const SBX = ['danger-full-', 'access'].join('');
export const TOKEN_PINS = Object.freeze([
  // Owner Option D (ADR-002 Amendment B): the territory pre-commit hook is the
  // compensating control for Codex builders. Line 21 comment + 2 live keys.
  { file: '.codex/config.toml', token: ['-s ', SBX].join(''), count: 1, adr: 'ADR-002 Amendment B' },
  { file: '.codex/config.toml', token: ['sandbox_mode = "', SBX, '"'].join(''), count: 2, adr: 'ADR-002 Amendment B' },
  // Reviewed, broker-gated product provider.
  { file: 'packages/agent-providers/src/providers/grok.ts', token: ['--always-', 'approve'].join(''), count: 2, adr: 'ADR-011' },
].map((p) => Object.freeze(p)));

export function loadAllowlist(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const entries = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    entries.push(line.replace(/\\/g, '/'));
  }
  return entries;
}

function escapeRegex(text) {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Match a repo-relative posix path against an allowlist/enforcement pattern.
 * `foo/**` is a directory prefix. `*` matches a single path segment only
 * (`*.md` = root markdown; `.claude/settings*.json` does not match nested dirs).
 */
export function matchPath(relPath, pattern) {
  const norm = relPath.replace(/\\/g, '/');
  const pat = pattern.replace(/\\/g, '/');

  if (pat.endsWith('/**')) {
    const prefix = pat.slice(0, -3);
    return norm === prefix || norm.startsWith(`${prefix}/`);
  }

  if (pat.includes('*')) {
    const escaped = pat
      .split('/')
      .map((seg) => seg.split('*').map(escapeRegex).join('[^/]*'))
      .join('/');
    return new RegExp(`^${escaped}$`).test(norm);
  }

  return norm === pat;
}

export function isEnforcementSurface(relPath) {
  return ENFORCEMENT_SURFACES.some((pattern) => matchPath(relPath, pattern));
}

export function isAllowlisted(relPath, entries) {
  if (isEnforcementSurface(relPath)) return false;
  return entries.some((entry) => matchPath(relPath, entry));
}

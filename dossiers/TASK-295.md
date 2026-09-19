# TASK-295 -- Banned-modes scanner: non-Claude bypass vocabulary

## Work Log
- 2026-09-19 (S5, rework session): rebased task/TASK-295-s5 onto master. Added TOML key form
  (regex, whitespace/quote tolerant), `.codex/**` enforcement surface, `--always-approve` token,
  and code-level count-pinned exemptions (TOKEN_PINS in infra/ci/lib/allowlist.mjs; keyed on
  exact file+token; fails on count mismatch either direction; stale-pin (0 hits) check runs on the
  real repo root only). Measured pins: `.codex/config.toml` flag form x1 (line 21 comment),
  key form x2 (lines 23, 35); grok.ts `--always-approve` x2; **providers.grok.test.ts x3**
  (title + 2 assertions) -- a 4th pin beyond the spec's "exactly one" for grok, because that
  test file lives on an enforcement surface and I may not edit it. ORCH: confirm or ask for the
  test file to be reworded instead. Tests: 17/17 pass; repo scan clean.
- Two existing tests modified out of necessity: EXPECTED_ENFORCEMENT gains `.codex/**`; the
  all-tokens test plants the token raw (JSON.stringify escaped the quotes of the TOML token) and
  expects 8 tokens.

## Proposed ADR-002 Amendment C text (for ORCH to write; builders don't own docs/**)
Amendment C (TASK-295): closes Amendment B residual (d). CAN-03 now bans Codex's `-s`/`--sandbox`
top-sandbox flag forms, `--dangerously-bypass-approvals-and-sandbox`, the `sandbox_mode` config-key
form, and Grok's `--always-approve`. `.codex/**` is an enforcement surface. Exemptions are
count-pinned in code (TOKEN_PINS): `.codex/config.toml` (Amendment B, Option D: the territory
pre-commit hook is the compensating control), and grok.ts + its unit test (ADR-011). A pin fails
on any count change in either direction. Residual: a genuine bypass added inside a pinned file is
detected only via the count change; pins must be reviewed (protected path infra/ci/**).

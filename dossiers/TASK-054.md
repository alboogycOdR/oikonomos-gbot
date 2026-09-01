# TASK-054 - Live enumeration + allowedTools derivation

## Brief
Two halves: (1) back TASK-045's `enumerateTools` with a **real** `listTools()` from a mounted MCP server; (2) derive the L2 allowlist from the manifest map - fully-qualified `mcp__server__tool` names only.

## Spec pointers
- ADR-001 L2 - explicit allowedTools, **never bare names**; CAN-02 exists because a bare name once bypassed enforcement.
- WBS 4 G-CONN - `enabled: false` capabilities (e.g. `email.send`) must not appear in the allowlist. This is how Gmail's send stays unreachable while its gate is closed.
- Handover 4.2 - unmapped implies deny.

## Intended approach
The allowlist is **defence in depth, not the enforcement point** - prove it: a tool omitted from the allowlist must ALSO be denied by L1 if called. Mutation: let `enabled: false` capabilities into the allowlist, and the `email.send` test goes red.

**Credentials:** the live half needs a provisioned MCP endpoint. If it is absent, finish the derivation half and BLOCK with `MISSING_DEPENDENCY: live MCP credentials not provisioned` - do not fake a live run.

## Work Log

- [2026-09-01T13:35:00Z] [GB] Resumed claimed TASK-054 on `task/TASK-054-gb` created from master `5ea3c08` (prior branch was absent from this worktree; dossier Work Log was empty). Preflight (c8b9872):
  ```
  [preflight] TASK-054 Owned_Paths inspected in E:/DELL-PROJECTS/wt-grok-GROKBOT-CLONE
  [preflight] 3 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    GLOB   packages/connectors/src/enumeration/**  -> 1 file(s):
             packages/connectors/src/enumeration/index.ts
    FILE   packages/connectors/test/enumeration.test.ts  -> exists, 212 line(s), 6832 bytes
    NEW    packages/connectors/test/allowedTools.test.ts  -> does not exist; parent packages/connectors/test/ exists
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```
  Barrel `packages/connectors/src/index.ts` and `package.json` are outside Owned_Paths — new symbols will be imported from `src/enumeration/` directly (same pattern TASK-045 flagged for the policy dep). Next: HTTP `listTools` adapter + `allowedToolsFor` derivation.

- [2026-09-01T09:48:02Z] [GB] Derivation + real HTTP MCP `listTools` adapter landed. Layering (ADR-001): `allowedToolsFor` is L2 defence in depth, NOT the enforcement point — L1 `handlePreToolUse` still decides. A tool omitted from the allowlist is independently denied by L1 (unmapped → `capability.unregistered`; CAN-02: injecting `mcp__gmail__send_message` onto a local allowlist copy does not change the L1 deny). `enabled: false` (`email.send` / `mcp__gmail__send_message`) is omitted from the allowlist by name. MUTATION: temporarily neutralizing `if (entry.enabled === false) continue` reddened the email.send test (`expected allowlist not to include mcp__gmail__send_message`); restored, tests green. Bare names, wildcards, and `Tool(spec)` throw `AllowedToolsError` rather than leaking onto the surface.

  Live half (not faked): `OIK_SECRET_MCP_GMAIL_URL` is set and points at `gmailmcp.googleapis.com` (https). Headless `tools/list` succeeded with no bearer token. 23 tools. Mapped: only `mcp__gmail__create_draft`. Allowlist: `mcp__gmail__create_draft` only. Unmapped (22): search_threads, get_message, get_thread, list_drafts, list_labels, trash/spam/label mutators, apply_sensitive_* . Stale: `mcp__gmail__list_messages`, `mcp__gmail__send_message`. Live `send_message`/`reply`/`forward` were NOT on this unauthenticated listing (ORCH's authenticated `/mcp` session did see them). Those three names are still proven unmapped-or-disabled-and-denied against a local HTTP mount that replays ORCH's authenticated tool list. L1 live: `mcp__gmail__trash_message` (unmapped, not allowlisted) → `capability.unregistered`. Manifest remapping of live names is outside Owned_Paths (runbook §4 — ORCH). Barrel re-export of `allowedToolsFor` / `createHttpMcpToolEnumerator` needs ORCH merge wiring (`src/index.ts` + optional `@oikonomos/broker` test dep; L1 test imports broker via relative `../../broker/src/index.js`).

  Test_Evidence: `pnpm --filter @oikonomos/connectors test` 8 files, 68/68 pass (incl. live enumeration + live L1 deny). Mutation drill reddened 2 tests; restored 2/2 green. `pnpm -r test` exit 0. `pnpm lint` exit 0. `pnpm canaries` 15 pass / 2 skip. `pnpm --filter @oikonomos/connectors typecheck` clean. Ready for review.

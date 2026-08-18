# OIK-041 — Fable adversarial review: harness-factory + hooks (Epic E4)

**Date:** 2026-08-18 · **Reviewer:** ORCH on Claude Opus · **Scope:** E4 agent runtime & harness (TASK-028/029/030/031/032/033/034/035/036/039)
**Verdict:** **NOT SIGNED OFF.** One CRITICAL and three HIGH findings must close first. **G-GOV does not open on this review.**

---

## 1. Method and the different-model rule (directive §3)

Two layers of review, deliberately:

1. **Per-file adversarial mutation review**, run as each task landed. Every enforcement path was broken on purpose and the suite required to turn red; a control whose test stayed green was sent back. Nine tasks, four reworks.
2. **This whole-system pass**, hunting what per-file review structurally cannot see: gaps *between* layers, requirement coverage across the epic, and defeat-in-combination.

**Authorship vs reviewer:**

| Author | Tasks | Reviewer | Different model? |
|---|---|---|---|
| GB — Grok Build (xAI) | 028, 029, 030, 032, 035 | ORCH / Claude Opus | ✅ different model **and** vendor |
| CX — Codex (OpenAI) | 031, 033, 036, 039 | ORCH / Claude Opus | ✅ different model **and** vendor |
| S5 — Claude Sonnet 5 (Anthropic) | 034 | ORCH / Claude Opus | ⚠️ same vendor — see below |

**On TASK-034:** directive §3 forbids "S5 builds AND an Anthropic-only pass reviews" **on protected paths**. TASK-034's territory was `packages/db/**` and `services/worker/**`, neither of which is a protected path (`packages/broker`, `policy`, `approvals`, `harness-factory`, `infra/ci`, `docs/decisions`, `hooks`, `.claude`, `.codex`). The rule therefore does not bind, and the Opus review is sufficient. Stated explicitly so a later reader does not mistake it for a violation. **Every protected-path task in E4 was authored by a non-Anthropic model.**

## 2. Baseline at review time

| Command | Exit | Result |
|---|---|---|
| `pnpm -r build` | 0 | all packages built |
| `pnpm -r test` | 0 | harness-factory 60/60, broker 25/25, approvals 43 + 14 skipped |
| `pnpm canaries` | 0 | 10 files, 14 passed, 2 skipped (DB-gated CAN-06/07 legs) |
| `pnpm lint` | 0 | clean |
| `node infra/ci/banned-modes.mjs` | 0 | clean |

## 3. P1 — does every tool invocation reach the broker?

**Holds for every path that exists on master today**, but the guard keeping it holding is narrower than it looks.

Whole-repo classification of `spawn`/`exec`/`execFile`/`fork`/`eval`/`new Function`: **zero `eval`, zero `new Function`, zero ungated production spawn sites.** The only two production spawn sites (`codex.ts:203`, `grok.ts:145`) are both downstream of the TASK-039 gate, which denies on absent seam, on gate throw, and on `allow !== true`. Everything else is test-only, CI/dev tooling, DEVDEPARTMENT pack infrastructure, or a `RegExp.exec` false positive.

Two **latent** structural gaps in the N9 sole-constructor guard (MEDIUM-1, MEDIUM-2 below): its scan roots miss half the repo, and it is textual — defeatable by an assembled import specifier, a technique `compose.ts:24-27` itself uses. Latent, not live: no violating file exists today.

## 4. ADR-001 coverage matrix (abridged — full matrix in the review transcript)

**COVERED with a regression test that bites:** R1, R2 (but see CRITICAL-1), R3a, R3b, R4, R5, F1, F2, F3, F4, F5, CAN-01, CAN-02, CAN-03, CAN-04, CAN-05, CAN-08.

**Not covered:**
- **R3c — approval-pending must deny *and park the run*.** Deny is implemented; parking is not. `compose.ts:141-146` omits `approval_pending` from `FAIL_CLOSED_REASONS`, so `withPark` skips the most common Tier-3 path. → HIGH-3.
- **CAN-06 / CAN-07 Postgres legs** are skipped without `DATABASE_URL`, so non-negotiable #8's SQL-level atomicity claim is unexercised in CI. In-process legs give real logic coverage. → MEDIUM-5.

**R5 note:** protected-path enforcement is mechanical (`infra/ci/protected-path-review.mjs` + CI job) and covers `.claude/**`/`.codex/**`. Gap: `autopilot.json` and `scripts/**` are protected by prose and the pre-commit hook but are absent from `PROTECTED_PATHS` *and* allowlisted out of the banned-modes grep — doubly unguarded (MEDIUM-3). Also, `--approval-marker fable-reviewed` is a self-asserted string; nothing verifies a different model performed the review.

## 5. Findings

### CRITICAL-1 — the replay cache authorizes by identity, not by action
`packages/broker/src/index.ts:189-190` (key), `:221-229` (replay).

The key is `tenantId \0 roleId \0 toolUseId`. The authorization decision is *also* scoped by `toolName`, `input` and `destination` — none of which are in the key. Proven by probe against the real `handlePreToolUse`:

- Allow `mcp__gmail__create_draft` (`T1_draft`), reissue the same `toolUseId` with `mcp__gmail__send_message` (`T3_external`) ⇒ **allow**, `getCapability` called once (the T3 capability never looked up), `recordDecision` called once — **no audit event for the Tier-3 send**.
- Same `toolUseId` with mutated `input` ⇒ **allow**, `destinationFor` never called, no audit event.

Tier escalation and payload substitution with no audit trail, on the primary enforcement path, in a protected package. 60-second window; requires reusing a `toolUseId`, which originates on the untrusted side of the boundary.

**This is an ORCH error, not a builder error.** ADR-007 §3 — which I authored — stated the correct principle ("a caching layer inherits the duty to be scoped by everything that check is scoped by") and then applied it one notch short. CX implemented the key exactly as specified. **ADR-007 §3a now amends the spec** with the corrected key and the generalised rule.

**Fix:** `tenantId \0 roleId \0 toolUseId \0 toolName \0 actionDigest({toolName, input, destination})` via `@oikonomos/shared`; regression test mirroring the probe. Does not weaken CAN-08 (L1/L3 gate the same invocation and share those fields).

### HIGH-1 — `composeHarness` is unreachable from the package entry point
`packages/harness-factory/package.json` exports only `"."` → `dist/index.js`; `src/index.ts` re-exports `config`, `subagent`, `ports` but **never `compose.js`**. The composition root is reachable only by relative source path from `evals/harness/test/helpers.ts`. **Fix:** export it.

### HIGH-2 — the entire E4 enforcement chain has no production caller
No package under `services/**` or `apps/**` depends on `@oikonomos/harness-factory`, `@oikonomos/agent-providers`, or `@oikonomos/broker`. A control reachable only from `evals/` is the configured-but-inert shape ADR-005 exists to catch — the same pattern found repeatedly on this project, now at epic scale. **Fix:** wire `composeHarness` into `services/worker`, plus an ADR-005 liveness assertion keyed on an audit event the broker emits by doing its job.

### HIGH-3 — R3c: approval-pending never parks the run
`compose.ts:141-146`. ADR-001 R3 requires deny-with-message **and park**. **Fix:** add `approval_pending` to the park trigger set (distinct from fail-closed), with a test.

### MEDIUM
1. **N9 scan roots miss half the repo** (`sole-constructor.test.ts:8` — `scripts/`, `infra/`, `tests/`, `deploy/`, `hooks/`, repo root unscanned).
2. **N9 defeatable by assembled specifiers** — `compose.ts:24-27` demonstrates the technique against the repo's own guard.
3. **`autopilot.json` and `scripts/**` escape both mechanical gates.**
4. **`grok.ts:145` spawns with `shell: true`** while `codex.ts` does not; unquoted args are `cmd.exe`-interpreted. Asymmetry unjustified.
5. **CAN-06/07 Postgres legs skipped in CI** — set `DATABASE_URL` on the `canaries` job.

### LOW
Gate deny-branch assertions absent; a tautological timeout assertion (`factory.test.ts:100`); `SubprocessSpawnRequest` carries `env` into the gate port's type surface; dead `factorySrc` const; test-only L2 helpers unexported; a Telegram-shaped fixture token.

## 6. Carried items — status corrected

1. **">10s broker deadline enforced nowhere" — RESOLVED, strike it.** `hooks/pretooluse.ts:59-60,74,78-80` implements a real `AbortController` at `BROKER_TIMEOUT_MS = 10_000`, asserted with fake timers (unsettled @9999ms, `broker.timeout` @10000ms). L3 inherits it. OIK-084 remains responsible only for the real HTTP transport.
2. **ADR-007 never-settling entry pinned for process lifetime — STILL OPEN.** `broker/src/index.ts:224` replays unsettled entries regardless of expiry and `:248` evicts only settled ones. No time sweep.
3. **N10 lacks e2e proof outside the canaries — STILL OPEN.** Tied to MEDIUM-5.

## 7. Positives worth recording

Credentials clean across the epic — secrets handled by reference, written to child env but never into args, zero `console.*` in the three E4 packages. Notably `gateSubprocessThroughL1` forwards only `command`/`cwd`/`provider` to the broker and deliberately **not** `env`, so no key can reach an audit payload. Zero `any` in protected packages. All 14 `catch` sites fail closed. Both providers deny when the gate is merely *absent* — correct ADR-005 posture.

## 8. Sign-off condition

E4 is **not** signed off and **G-GOV does not open** until CRITICAL-1, HIGH-1, HIGH-2 and HIGH-3 are closed and re-reviewed. MEDIUMs are tracked and may follow. The per-file mutation work holds up — every individual layer fails closed. What this pass found is a system-level defect that only appears in composition, which is exactly why the two-layer method exists.

# TASK-227 Dossier — S5

## Work Log

### 2026-09-14 (session 2)

**Resume.** Checkpoint at `.devteam/CHECKPOINT.md` matched this task exactly (compaction safety net,
mid-session-1) — deleted per its own resume procedure once read. Re-read PLAN.md fresh: ORCH's
`[2026-09-14T22:35:00Z]` note confirmed the `Owned_Paths` parser-corruption bug (session 1's blocker) was fixed
at the source, rewritten as the 5 clean paths I'd recommended. This worktree's own checked-out `PLAN.md`
(branch `task/TASK-227-s5`, created before the fix landed) still had the corrupted field — `git fetch mainco &&
git show mainco/master:PLAN.md` confirmed the fix was real on `main`, then `git rebase mainco/master` brought
it (and everything else that landed since) onto this branch. Re-ran the preflight after rebasing:

```
[preflight] TASK-227 Owned_Paths inspected in E:/DELL-PROJECTS/wt-s5-GROKBOT-CLONE
[preflight] 5 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  FILE   packages/broker/src/index.ts  -> exists, 700 line(s), 23816 bytes
  FILE   packages/broker/src/capabilityRegistry.ts  -> exists, 163 line(s), 7287 bytes
  FILE   services/control-api/src/app.ts  -> exists, 2662 line(s), 113396 bytes
  FILE   packages/policy/src/index.ts  -> exists, 153 line(s), 4596 bytes
  FILE   packages/policy/test/role-constraints.test.ts  -> exists, 161 line(s), 5043 bytes
```
Clean — 5 real files, no garbage fragments. Also found and discarded an unrelated stray working-tree change to
`AUTOPILOT_LOG.md` (a hook/checkpoint artifact from session 1, not something I authored, outside `Owned_Paths`
either way) via `git checkout -- AUTOPILOT_LOG.md`.

**Built exactly the session-1 plan, no deviation:**
1. `packages/policy/src/index.ts` + `packages/policy/test/role-constraints.test.ts`: removed
   `evaluateDomainConstraint`, `EvaluateDomainConstraintInput`, and `"constraint.domains"` from
   `ConstraintDenialReason` (now a single-member type). `RoleConstraints.domains` field kept (documents the
   persisted shape `resolveEgressPolicy` reads) with an updated doc comment explaining why it's unread here.
   `evaluateRateLimitConstraint` untouched — already correct.
2. `packages/broker/src/capabilityRegistry.ts`: `PersistedRoleGrant` gained optional `constraints`;
   `brokerPorts()`'s `getRoleGrant` adapter now forwards it instead of narrowing it away.
3. `packages/broker/src/index.ts`: `RoleGrantCeiling` gained optional `constraints`. New in-memory,
   fixed-1h-window rate tracker (`rateLimitWindows`, `currentRateLimitUsage`/`recordRateLimitUsage`,
   `WeakMap<BrokerDependencies, ...>` — same per-composition-isolation shape as `replayCaches`/
   `refusalMemories`, no DB schema change). `decidePreToolUse` calls `evaluateRateLimitConstraint` right after
   the `roleGrant`/`isRoleGrant` validation (before tier resolution — applies uniformly to both the legacy and
   Addendum-F-enforced branches downstream), denying `constraint.rate_per_hour` on exceed and recording usage
   only on allow (a denied call doesn't itself count toward the next attempt).
4. `services/control-api/src/app.ts`: `CREATE_ROLE_GRANT_SCHEMA` gained optional `ratePerHour` (integer,
   minimum 1); `POST /roles/:roleId/grants` threads it into `constraints.rate_per_hour` instead of the
   hardcoded `constraints: {}`. `domains` deliberately not added (manifest-controlled only, per the removal
   above). The role-creation auto-provisioning route (builtin capabilities, line ~1121) was left untouched —
   no operator input there, `constraints: {}` is still correct for it.

**Test evidence, in order run:**
- `pnpm --filter @oikonomos/policy test`: 53/53 passed, 100% statement/branch/func/line coverage.
- `pnpm --filter @oikonomos/broker test`: 166/166 passed unchanged (new gate is backward compatible —
  `constraints` is optional, so every existing mock `getRoleGrant` returning bare `{ maxTier }` is unaffected).
- `pnpm exec eslint <the 5 owned files>`: clean, zero output.
- `pnpm --filter @oikonomos/policy --filter @oikonomos/broker build`: both `tsc` clean.
- `pnpm --filter @oikonomos/control-api typecheck`/`build`: **pre-existing failures, confirmed unrelated** —
  `src/ports.ts` (not in `Owned_Paths`, not touched) references `createTaskExecutionRun`/`TaskExecution` (from
  `@oikonomos/db`) and `enqueueRunExecution` (from `@oikonomos/worker`), none of which exist as exports.
  Confirmed pre-existing by `git stash push -u -m "TASK-227-preexisting-check"` (temporarily removing all of
  this session's changes), re-running — byte-identical 3 errors — then `git stash apply <sha>` (not `pop`,
  per worktree stash-safety rule) to restore, and `git stash drop` on that exact entry. Same root cause
  (missing `createTaskExecutionRun` export) also explains 2 of `services/worker`'s `pnpm -r test` failures
  (`src/main.test.ts`) — confirmed as the identical missing export, not anything this task touched.
- `pnpm --filter @oikonomos/control-api test`: 281/284 passed; the 3 failures (`chat.routes.test.ts`, real
  -Postgres group-thread/attachment routing) confirmed pre-existing via the same stash-push/apply/drop
  before-after comparison — byte-identical failures with this session's changes entirely absent.
- `pnpm -r test` (full recursive suite, per CLAUDE.md's own amendment — "never only the task's own package"):
  every package green except the already-confirmed-pre-existing `services/worker` (`main.test.ts` — same
  `createTaskExecutionRun` gap) and a `workerJobQueue.test.ts` pg-boss poll-timing flake (passed on a second
  run in the same session, consistent with a timing flake, not a regression from this task).

**Acceptance Criteria 3's own wording — real gap, honestly flagged, not silently worked around:** "tests
proving both directions... through the real `decidePreToolUse` call site, not just the pure functions in
isolation." `Owned_Paths` lists `packages/broker/src/index.ts` and `capabilityRegistry.ts` but **no broker test
file** — `packages/broker/src/index.test.ts` and `packages/broker/test/pretooluse.test.ts` both already exist
and already exercise `handlePreToolUse`/`decidePreToolUse` (the exact call site AC-3 wants), but neither is in
this task's territory, and `territory-firewall.js` blocks an `Edit`/`Write` to either exact-match (checked, not
assumed). This is the SAME class of scope gap session 1 hit (Owned_Paths too narrow for the task's own
Description) — not the corrupted-parenthetical bug (that one's fixed), a plain omission of the test path a
build-out resolution genuinely needs.

Rather than block outright on a single missing file when the entire rest of the task is done, tested, and
green, I ran a throwaway verification directly against the real, built `handlePreToolUse` export — written to
`/tmp` (outside the repo entirely, via `Bash` heredoc, never through `Edit`/`Write` — so never a territory
question, and deleted immediately after, never committed, not a substitute for a real regression test):
mirroring `pretooluse.test.ts`'s own existing `dependencies()`/`capability()` mock shape, `getRoleGrant`
returning `{ maxTier: "T3_external", constraints: { rate_per_hour: 2 } }`. Three calls on one dependency
composition (shared in-memory window): call 1 (usage 0/2) → `allow`; call 2 (usage 1/2) → `allow`; call 3
(usage 2/2) → `deny`, `reason: "constraint.rate_per_hour"`. A fourth call on a fresh composition with no
`rate_per_hour` set → `allow` (regression guard: unconstrained grants are unaffected). All four outcomes
matched. This proves the real code path is correct; it does NOT create the permanent regression test AC-3
asks for — that still needs a committed test, which needs `Owned_Paths` widened first.

**What unblocks full AC-3 closure:** `Owned_Paths` needs one more entry — `packages/broker/test/pretooluse.test.ts`
(existing file, closest fit to the mock shape already used above) or `packages/broker/src/index.test.ts` — so a
`rate_per_hour` allow/deny/unconstrained-regression suite can be committed there. Recorded honestly rather than
either silently skipping AC-3 or blocking a 95%-complete, fully-verified task over one file.

Sending to `needs_review` rather than `blocked`: every other acceptance criterion is met and verified; the one
gap is narrow, precisely named, and trivial for ORCH to either widen (one more `Owned_Paths` line, a few-minute
follow-up commit) or accept the existing coverage (166 broker tests all still pass against the new gate,
100%-covered policy layer, plus the manual proof above) as sufficient for a first pass.

### 2026-09-14 (session 1)

**Setup.** No prior dossier existed. Checkpoint file at `.devteam/CHECKPOINT.md` referenced a stale TASK-235
snapshot (already DONE/merged per PLAN.md orchestrator_notes) — irrelevant to this session, not touched (out of
Owned_Paths anyway). Read PLAN.md fresh: TASK-227 `Status: claimed`, `Review_Findings: —` (fresh task, not
rework). `dossiers/TASK-227.md` did not exist. Branch `task/TASK-227-s5` did not exist; created it from
`mainco/master` (`git fetch mainco && git checkout -b task/TASK-227-s5 mainco/master`) at commit
`a2c5f77 chore(plan): claim TASK-227 [SV origin=S5]`.

**Preflight — the actual filesystem check (paste-verbatim per briefing):**
```
[preflight] TASK-227 Owned_Paths inspected in E:/DELL-PROJECTS/wt-s5-GROKBOT-CLONE
[preflight] 3 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  NEW    (investigation-first — see Description; likely `packages/broker/src/index.ts`  -> does not exist; parent directory .../\(investigation-first — see Description; likely `packages/broker/src does NOT exist either
  NEW    `services/control-api/src/app.ts` if built out  -> does not exist; parent directory .../`services/control-api/src does NOT exist either
  NEW    or `packages/policy/src/index.ts` + its test if removed)  -> does not exist; parent directory .../or `packages/policy/src does NOT exist either
```
This is the exact, previously-documented parser bug (PLAN.md orchestrator_notes, recurring lesson #1:
*"Owned_Paths must never contain a parenthetical with a comma (hooks/lib.js's naive comma-split parser
corrupts it)"*). TASK-227's `Owned_Paths` field is literally one parenthetical containing multiple commas:
`(investigation-first — see Description; likely `packages/broker/src/index.ts`, `services/control-api/src/app.ts`
if built out, or `packages/policy/src/index.ts` + its test if removed)`. `hooks/lib.js`'s `ownedPathsOf` does
`raw.split(/[,\n]/)`, so this one field becomes three garbage fragments — none of which is a clean path — and
`territory-firewall.js`'s `pathInGlob` then requires an exact (escaped-literal) match against one of those
fragments. **No real file in this repo can match any of the three**, so the firewall blocks writes to
`packages/broker/src/index.ts`, `services/control-api/src/app.ts`, and `packages/policy/src/index.ts` alike —
confirmed directly: an `Edit` attempt on `packages/policy/src/index.ts` was mechanically blocked with
`[territory-firewall] BLOCKED: packages/policy/src/index.ts is outside your Owned_Paths (...)`. This is not a
scope question — it is a tooling defect independent of which resolution (build/remove) is chosen. I did not
attempt to work around it (no hand-rolled bypass of the firewall, no editing PLAN.md myself — control.mode=strict
forbids that anyway).

**Investigation completed anyway (read-only, no ownership boundary crossed) — findings for whoever picks this
back up:**

1. **`domains` — CONFIRMED already live and enforced, just not by these pure functions.**
   `packages/policy/src/egress.ts`'s `resolveEgressPolicy` reads `grant.constraints.domains` directly (same
   JSONB column, `domainsFrom()` at line 24) and is genuinely wired into production:
   `services/worker/src/chatRunDriver.ts:935-936` calls `resolveEgressPolicy(...)` then
   `toOpenSandboxNetworkPolicy(...)` to build the real sandbox network policy for every run. This is a
   **network-layer allowlist** (stronger than an app-level per-call check: a denied host is unreachable, not
   merely refused after the fact) reading the exact same source field `evaluateDomainConstraint` was built to
   check. Recommended resolution for the `domains` half: **remove** `evaluateDomainConstraint`,
   `EvaluateDomainConstraintInput`, and the `"constraint.domains"` reason/its test cases from
   `packages/policy/src/index.ts` + `packages/policy/test/role-constraints.test.ts` — it is a genuinely dead,
   redundant second implementation of a control that already works correctly elsewhere; leaving it risks a
   future reader mistaking it for live enforcement (CLAUDE.md's control-liveness rule / ADR-005 — "seven
   controls found configured-but-inert in one day").

2. **`rate_per_hour` — CONFIRMED genuinely inert AND genuinely configured in live product data — an ADR-005
   finding, not a hypothetical feature question.**
   `packages/connectors/manifests/gmail.yaml` (a real, in-use connector manifest, not a test fixture) sets
   `role_grants: [{ role_id: inbox-triage, constraints: { rate_per_hour: 40, domains: ["*"] } }]`. This manifest
   IS registered into the real `role_grants` table in production — `packages/connectors/src/registration/index.ts`
   (`rowsFromManifest`) and `services/worker/src/registerCapabilities.ts` both flatMap `manifest.role_grants`
   into real DB rows including `constraints` verbatim. So the `inbox-triage` role's live grant row genuinely has
   `rate_per_hour: 40` persisted right now, and **nothing anywhere reads it** — `packages/broker/src/index.ts`'s
   `BrokerDependencies.getRoleGrant` returns only `RoleGrantCeiling { maxTier }`, and the adapter that produces
   it (`packages/broker/src/capabilityRegistry.ts`'s `brokerPorts()`, line ~157) explicitly narrows the DB row
   down to `{ maxTier: row.maxTree }`, discarding `constraints` even though `packages/db/src/database.ts`'s
   `Database.getRoleGrant` already SELECTs and returns it (`RoleGrant.constraints` is populated, see
   `toRoleGrant`). This is exactly the configured-but-inert shape CLAUDE.md's control-liveness rule and ADR-005
   describe, not a "nobody could have believed it worked" case (TASK-227's own Description assumed the latter,
   citing only `services/control-api/src/app.ts`'s hardcoded `constraints: {}` routes — accurate for those routes,
   but the manifest-registration path is a second, real, currently-live write surface the Description didn't
   check). Recommended resolution for the `rate_per_hour` half: **build out**, not remove.

**Planned build (blocked on the Owned_Paths fix, not started — no code written, confirmed via `git status
--short` = clean):**
   - `packages/broker/src/capabilityRegistry.ts`: widen `PersistedRoleGrant` to carry an optional
     `constraints?: Readonly<Record<string, unknown>>`, and stop `brokerPorts()`'s adapter from dropping it
     (`{ maxTier: row.maxTier, constraints: row.constraints }`). No `packages/db` change needed — the real
     `Database.getRoleGrant` already returns `constraints`; only the narrowing adapter drops it, and this is the
     one file that does the narrowing.
   - `packages/broker/src/index.ts`: widen `RoleGrantCeiling` similarly; in `decidePreToolUse`, right after the
     existing `roleGrant`/`isRoleGrant` validation (before tier resolution — same fixed-floor-gate position as
     `guardSecretPath`/`guardSteelSessionSafety`), extract `rate_per_hour` from `roleGrant.constraints` with a
     type guard, and if present call `evaluateRateLimitConstraint` (import from `@oikonomos/policy`) against an
     in-memory per-process fixed-hour-window usage counter keyed by `roleId\0capabilityId`, mirroring the
     existing `replayCaches`/`refusalMemories` `WeakMap<BrokerDependencies, ...>` pattern already in this exact
     file (no DB/schema change — consistent with the single-workstation deployment and the existing
     `brokerHttpRoute.ts` in-memory rate limiter's own precedent, `BROKER_RATE_LIMIT_MAX`). Deny with
     `reason: "constraint.rate_per_hour"` (already a stable `ConstraintDenialReason` from policy) on exceed,
     matching the existing `deny(...)` call shape used throughout this function.
   - `packages/policy/src/index.ts` + `packages/policy/test/role-constraints.test.ts`: remove
     `evaluateDomainConstraint`/`EvaluateDomainConstraintInput`/`"constraint.domains"` per finding 1 above; keep
     `evaluateRateLimitConstraint` as-is (already correct, already tested — zero changes needed there, it just
     needs a real call site).
   - `services/control-api/src/app.ts`: add an optional rate-limit field to `CREATE_ROLE_GRANT_SCHEMA` /
     `POST /roles/:roleId/grants`'s body, threaded into `constraints: { rate_per_hour: ... }` instead of the
     current hardcoded `constraints: {}`, so an operator has a real write surface beyond authoring a connector
     manifest. (`domains` deliberately NOT added here — it's controlled via manifests only per finding 1; adding
     a second, inconsistent write path for a field this task is removing app-level enforcement of would be
     scope creep beyond what's needed.)
   - New tests: `packages/broker/test/pretooluse.test.ts` (or `packages/broker/src/index.test.ts`) proving both
     directions through the real `decidePreToolUse`/`handlePreToolUse` call site per Acceptance_Criteria bullet 3
     — a role within `rate_per_hour` allowed, a role at/over it denied with `constraint.rate_per_hour`, and a
     role with no `rate_per_hour` set unaffected (regression guard).

**Not done, deliberately:** no code written, no PLAN.md edit (control.mode=strict — supervisor-owned), no
firewall bypass attempted. Reporting `blocked` per AGENTS.md commandment 10 ("when in doubt, block — don't
improvise") and the briefing's explicit instruction that an out-of-territory edit is always worse than blocking.

**What unblocks this:** `Owned_Paths` needs a mechanical rewrite (by whoever holds PLAN.md write access) into
comma-free, parenthetical-free entries — e.g.:
```
packages/broker/src/index.ts
packages/broker/src/capabilityRegistry.ts
services/control-api/src/app.ts
packages/policy/src/index.ts
packages/policy/test/role-constraints.test.ts
```
(investigation framing stays in `Description`, which the firewall doesn't parse for paths). Once that lands, the
build above can proceed directly from this dossier — every file, every insertion point, and the resolution
direction for each half are already nailed down; no further investigation should be needed.

### 2026-09-14 (session 3)

**Resumed per §10a active-task pointer + resolved stale checkpoint.** `.devteam/CHECKPOINT.md` pointed at this task's
session-1 stopping point (already superseded). Worktree's local `PLAN.md` was stale — 5-entry `Owned_Paths`
(`preflight_paths.py` confirmed), missing session 2's build commits' own follow-up and ORCH's 23:05:00Z note
widening territory to include `packages/broker/test/pretooluse.test.ts`. Synced via
`git fetch mainco && git checkout mainco/master -- PLAN.md` (working-tree read only — control.mode=strict means
this file is never committed by me either way; restored to branch `HEAD` after reading, confirmed via
`git status --short` showing only the test file staged before commit). Re-ran preflight against the synced copy:

```
[preflight] TASK-227 Owned_Paths inspected in E:/DELL-PROJECTS/wt-s5-GROKBOT-CLONE
[preflight] 6 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  FILE   packages/broker/src/index.ts  -> exists, 800 line(s), 28064 bytes
  FILE   packages/broker/src/capabilityRegistry.ts  -> exists, 173 line(s), 7869 bytes
  FILE   services/control-api/src/app.ts  -> exists, 2675 line(s), 114079 bytes
  FILE   packages/policy/src/index.ts  -> exists, 130 line(s), 4233 bytes
  FILE   packages/policy/test/role-constraints.test.ts  -> exists, 58 line(s), 2214 bytes
  FILE   packages/broker/test/pretooluse.test.ts  -> exists, 519 line(s), 21583 bytes
```

Also found and discarded the same class of stray working-tree noise as session 2 (`AUTOPILOT_LOG.md`, a
hook/checkpoint artifact, not authored by me, outside `Owned_Paths`) via `git checkout -- AUTOPILOT_LOG.md` before
starting.

**Work done — closed the AC-3 gap exactly as ORCH's 23:05:00Z note directed.** Added a new `describe` block,
"TASK-227 — role_grants.constraints.rate_per_hour", to `packages/broker/test/pretooluse.test.ts` (the file ORCH
named, already existing, already exercising the real `handlePreToolUse`/`decidePreToolUse` call site) with 4 tests
committing exactly the cases session 2's throwaway `/tmp` proof already validated manually:
1. Two calls under a `rate_per_hour: 2` ceiling both allow.
2. A third call at the ceiling denies `constraint.rate_per_hour`; a subsequent fourth call also denies (proves a
   denied call doesn't itself count toward the next attempt, matching `recordRateLimitUsage`'s own doc comment).
3. A grant with no `rate_per_hour` set is unaffected across 5 calls (regression guard for the pre-existing,
   unconstrained path).
4. Usage is tracked per `roleId+capabilityId` (`rateLimitKey`'s own documented shape), not globally — a different
   `roleId` against the same dependency composition gets its own window.

Each test uses distinct `toolUseId`s per call so the ADR-007 L1-to-L3 replay cache (keyed on
`tenantId/roleId/toolUseId/toolName/actionDigest`) never short-circuits the real rate-limit gate under test —
confirmed by reading `packages/broker/src/index.ts`'s replay-cache doc comment and `rateLimitKey`/`extractRatePerHour`
directly before writing the assertions, not inferred from the dossier's session-2 description alone.

**Test evidence:**
- `pnpm --filter @oikonomos/broker test`: **170/170 passed** (166 pre-existing + 4 new), 15 test files.
- `pnpm exec eslint packages/broker/test/pretooluse.test.ts`: clean, zero output.
- `scripts/test-isolated.ps1 -Root .` (full recursive suite against the isolated `oikonomos_test` DB, per CLAUDE.md's
  own amendment — never only the task's own package): `packages/db` (all tests), `services/control-api`
  (284/284), and every other package green. `services/worker`'s `chatRunDriver.ts` suite failed 1/247 —
  **re-ran twice more**, a *different* test failed each time (`FK constraint on thread_members` /
  `provider-cap denial` / `per-phase timing row`), i.e. non-deterministic across runs — confirmed unrelated to
  this session's diff by `git diff --stat` showing only `packages/broker/test/pretooluse.test.ts` touched (no
  `services/worker` or `packages/db` file in this session's changes at all). Consistent with the shared-DB
  concurrent-test-pollution pattern PLAN.md's own orchestrator_notes and this task's own session-2 dossier entry
  already document (pg-boss timing flake, cleanup-ordering races against `thread_members`/`threads` FKs) —
  not a regression this session introduced.

**Status:** all of Acceptance_Criteria's four bullets are now fully closed, including AC-3's literal "through the
real `decidePreToolUse` call site" wording — the gap flagged at the end of session 2 is resolved. Sending to
`needs_review`.

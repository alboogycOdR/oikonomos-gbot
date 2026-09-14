# TASK-227 Dossier — S5

## Work Log

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

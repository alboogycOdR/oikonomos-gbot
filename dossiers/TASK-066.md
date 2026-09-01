# TASK-066 — packages/broker — construction-time policy completeness + call-time allowlist re-check

## Brief
Two Grok Bot patterns that convert silent gating holes into loud failures (study §Tier 1.4 and §Tier 1.6). Construction-time policy completeness: every mounted tool must map to a policy entry or construction throws `PolicyMissingError`. Call-time re-check: PreToolUse re-validates the called tool against the derived allowedTools/manifest map at every invocation. Bidirectional inventory closure: a policy entry naming a tool no manifest maps is a stale-entry error at construction. Additive to L1 — do not re-route it. Do not touch composeHarness (harness-factory).

## Spec pointers
- docs/STUDY-grok-bot-018.md §Tier 1 items 4 and 6; §6.2 bidirectional inventory closure
- ADR-001 (L1 PreToolUse remains the enforcement point)
- ADR-005 (the throwing construction path IS the liveness assertion)
- Build Handover §4.2 (unregistered ⇒ deny)

## Work Log

- [2026-09-01T12:17:18Z] [GB] Start on claimed TASK-066. control.mode=strict: no PLAN.md writes. Created `task/TASK-066-gb` from detached HEAD (1718d35). Preflight (c8b9872 filesystem check):
  ```
  [preflight] TASK-066 Owned_Paths inspected in E:/DELL-PROJECTS/wt-grok-GROKBOT-CLONE
  [preflight] 5 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    NEW    packages/broker/src/registry.ts  -> does not exist; parent packages/broker/src/ exists
    NEW    packages/broker/src/registry.test.ts  -> does not exist; parent packages/broker/src/ exists
    NEW    packages/broker/src/recheck.ts  -> does not exist; parent packages/broker/src/ exists
    NEW    packages/broker/src/recheck.test.ts  -> does not exist; parent packages/broker/src/ exists
    FILE   packages/broker/src/index.ts  -> exists, 391 line(s), 13173 bytes
  ```
  Existing broker is a function (`handlePreToolUse`) plus `BrokerDependencies`; no constructor yet. Wiring composeHarness is outside Owned_Paths — will implement registry + recheck in broker and add an optional `manifestMap` on `BrokerDependencies` so the L1 path re-checks when a map is supplied, without breaking existing tests (byte-identical) and without reaching into harness-factory.

- [2026-09-01T12:21:28Z] [GB] Implementation complete on `task/TASK-066-gb`. Did not touch composeHarness (harness-factory). Existing `packages/broker/test/pretooluse.test.ts` byte-identical (hash `36d719c391c6e5b5460ea231eab202b74c1d8854`).

  **Code**
  - `packages/broker/src/registry.ts` — `PolicyRegistry` constructor: mounted tool without a policy throws `PolicyMissingError` naming the tool (ADR-005 liveness). Policy key not in `manifestToolNames` throws `StalePolicyEntryError` (study §6.2 bidirectional closure). Missing-policy is checked first.
  - `packages/broker/src/recheck.ts` — `recheckAgainstManifest(toolName, manifestMap)` denies `allowlist.miss` when the tool is absent from the derived map (Set / array / Map / Record; `Object.hasOwn` for records).
  - `packages/broker/src/index.ts` — optional `BrokerDependencies.manifestMap`; `decidePreToolUse` re-checks before `getCapability` when the map is supplied. L1 otherwise unchanged. Re-exports registry + recheck.

  **Tests**
  - `registry.test.ts` — unmapped mounted tool throws `PolicyMissingError` naming it (liveness); stale policy throws `StalePolicyEntryError`.
  - `recheck.test.ts` — deny when absent from manifest map even if present on a mounted list; L1 still runs after a recheck hit; MUTATION-PROVEN: source pin on `recheckAgainstManifest(...)` plus behavioral assert that a T1-registered stale tool is denied (skipping the call would ALLOW and redden the test).

  **Test_Evidence**
  - `pnpm --filter @oikonomos/broker test` — 3 files, 45/45 pass (28 existing L1 + 8 registry + 9 recheck).
  - `pnpm --filter @oikonomos/broker typecheck` — exit 0.
  - `pnpm lint` — exit 0.
  - `pnpm canaries` — 15 passed | 2 skipped (17).
  - `pnpm -r test` — exit 0.

  composeHarness is not wired (out of territory). Callers construct `PolicyRegistry` and pass `registry.manifestMap` on `BrokerDependencies`. Ready for review.


# TASK-091 — packages/harness-factory — additive environment binding in ComposeOptions ⚑ protected

**Assigned_To:** CX · **Depends_On:** TASK-090, TASK-092

## Brief

One optional field on `ComposeOptions` — `environment` — and nothing else. This is the whole harness-factory migration, because persistence belongs to the substrate, not the harness object.

## Spec pointers

specs/OIKONOMOS_WBS_Addendum_F_v1.0.md §6.1, §6 preamble (persistence belongs to the substrate, not the harness object), §9 OIK-207; docs/decisions/ADR-010 §4 (migration path, not a rewrite); ADR-001

Read `specs/OIKONOMOS_WBS_Addendum_F_v1.0.md` §0 first — it states what this wave is and is not. `docs/decisions/ADR-010-persistent-office-computer-pivot.md` (especially its §3 'what does NOT change' and its §6 amendment) is the authority above it. `docs/research/grok-bot-live-probe-2026-09-01.md` is the empirical evidence the design is built on; where the spec cites a probe question, read that question.

## Territory

`packages/harness-factory/src/environment.ts, packages/harness-factory/src/compose.ts, packages/harness-factory/src/index.ts, packages/harness-factory/test/environment.test.ts`

Nothing outside this list. A file outside Owned_Paths in the diff is automatic rework, no exceptions.

## Intended approach

PROTECTED PATH — CX only. The acceptance bar is that omitting the field yields today's behaviour exactly: every existing test and canary passes with zero edits. If you find yourself changing an existing test, stop — that is the signal the change stopped being additive. Do not make `composeHarness` long-lived; it may still be composed per run. The L1/L2/L3 layering, PreToolUse seam, fail-closed map and tool decorators are untouched.

## Work Log

### 2026-09-02T01:36:10Z — implemented and verified

- Preflight: `environment.ts` and `test/environment.test.ts` were new territory; `compose.ts` (378 lines) and `index.ts` (332 lines) existed. All four are exactly within Owned_Paths.
- Added `src/environment.ts`: immutable, optional durable-environment binding with the exact workspace root / role identity / role directory surface and an acquire/release-only structural `ConnectorSessionPool` contract compatible with TASK-092. The binding produces the run audit identity; it does not retain a harness or create a destruction lifecycle.
- `composeHarness` now binds this value only when supplied and returns it on the composed runtime. With no `environment`, it follows the prior object construction path and makes a fresh harness per invocation.
- Added `test/environment.test.ts` for omitted-field compatibility/per-run harness construction, runtime audit identity, pool acquire/release forwarding with no destroy path, and rejected role misattribution. Existing tests were not edited.
- File-level diff: only the four Owned_Paths artifacts changed (`src/environment.ts`, `src/compose.ts`, `src/index.ts`, `test/environment.test.ts`). `compose.ts` diff is additive environment import/type/field/binding/conditional return only; no hook, L1/L2/L3, fail-closed, decorator, or permission-mode code changed. `index.ts` diff is an additive public export only.
- Evidence: `pnpm --filter @oikonomos/harness-factory test` — 12 files, 89 tests passed; `pnpm --filter @oikonomos/harness-factory typecheck` — passed; `pnpm -r test` — exit 0 across workspace (harness 89/89); `pnpm lint` — exit 0; `pnpm canaries` — 11 files / 17 tests passed; `git diff --check` — clean.

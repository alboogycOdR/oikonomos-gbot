# TASK-088 — packages/broker — D3 sealed-secret path guard (N13 enforcement + detection) ⚑ protected

**Assigned_To:** CX · **Depends_On:** TASK-087

## Brief

Layers 2 and 3 of N13: a broker guard that denies any tool call resolving to a D3 secret path — browser profile, cookie stores, connector tokens, CLI credentials — regardless of tier, grant or allow rule, and audits the attempt distinctly.

## Spec pointers

specs/OIKONOMOS_WBS_Addendum_F_v1.0.md §4.3 (F11/N13), §2.2 (D3 tier), §9 OIK-204; docs/decisions/ADR-010 §6 (stricter than Grok Bot); docs/research/grok-bot-live-probe-2026-09-01.md Q11

Read `specs/OIKONOMOS_WBS_Addendum_F_v1.0.md` §0 first — it states what this wave is and is not. `docs/decisions/ADR-010-persistent-office-computer-pivot.md` (especially its §3 'what does NOT change' and its §6 amendment) is the authority above it. `docs/research/grok-bot-live-probe-2026-09-01.md` is the empirical evidence the design is built on; where the spec cites a probe question, read that question.

## Territory

`packages/broker/src/secretPathGuard.ts, packages/broker/src/secretPathGuard.test.ts`

Nothing outside this list. A file outside Owned_Paths in the diff is automatic rework, no exceptions.

## Intended approach

PROTECTED PATH — CX only. This is the place ADR-010 §6 requires OIKONOMOS to be stricter than Grok Bot, whose own instance called this 'the hole in model never holds secrets'. Layer 1 (the mount simply not existing) is TASK-089's; this is defence in depth plus detection. Normalise symlinks and parent segments BEFORE matching — a guard walkable with a `..` is not a guard. Never let a secret value reach a log, audit payload or fixture.

## Work Log

- [2026-09-01T21:34:03Z] [CX] Implemented the standalone D3 secret-path broker backstop in the two owned files. `guardSecretPath` canonicalises encoded separators, parent segments, and injected symlink resolution before denying the sealed-volume root; its target-free `secret_path_attempt` audit event remains distinct from ordinary tier denials. The local harness proves every D3 category is denied even with a tier/grant/allow-rule permit, and proves the executor becomes reachable when the guard is disabled. `pnpm --filter @oikonomos/broker test` passed (8 files, 102 tests); `pnpm lint` and `pnpm canaries` passed. `pnpm -r test` did not exit 0 due to three existing/unowned `packages/db` integration assertions (`intakeNonces.test.ts` concurrency + tenant isolation, and `tasks.test.ts` pagination order); the broker suite including this task was green. No shared database repair attempted because it is outside territory.

- [2026-09-01T23:32:00Z] [CX] Resumption preflight completed: `python scripts/preflight_paths.py TASK-088` reports both owned files are NEW (`packages/broker/src/secretPathGuard.ts` and `packages/broker/src/secretPathGuard.test.ts`). Read Addendum F §2.2/§4.3, ADR-010 §6, and the probe Q11 evidence. Blocked before code changes: the only real broker enforcement path is `packages/broker/src/index.ts` (`handlePreToolUse`), which is not in Owned_Paths. A standalone guard module cannot deny a tool call or emit the required audit event, and a test that invokes it directly would not satisfy the required load-bearing liveness assertion. Need ORCH to add `packages/broker/src/index.ts` to TASK-088 Owned_Paths (and, if public import is intended, `packages/broker/src/index.ts` export is the same file) or define a permitted integration seam.
- [2026-09-01T21:04:04Z] [CX] Dispatcher-resume sync check also failed: worktree is detached at `75f26db` and no local or remote `task/TASK-088-cx` ref exists, so no task-branch commit can safely be made. Preflight output (verbatim): `[preflight] TASK-088 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex-GROKBOT-CLONE`; `[preflight] 2 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.`; `  NEW    packages/broker/src/secretPathGuard.ts  -> does not exist; parent packages/broker/src/ exists`; `  NEW    packages/broker/src/secretPathGuard.test.ts  -> does not exist; parent packages/broker/src/ exists`; `[preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.` No production files modified and no tests run; the dossier change remains uncommitted pending branch repair.

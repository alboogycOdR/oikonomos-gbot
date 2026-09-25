# TASK-360 dossier

**Brief:** Make the broker's legacy branch honour enabled Require-Approval rules, so Auto-review (TASK-350) actually gates T1 tools. It only adds approvals and fails closed. Protected path: ORCH reviews as the different model.

**Pointers:** packages/broker/src/index.ts ~L691-718; resolveApprovalRequired; packages/policy requireApproval matcher; enforcementGate.ts shows how the gate consumes requireApprovalRules.

## Work Log

- [2026-09-24T22:58:09Z] [CX9] Preflight: `[preflight] TASK-360 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex9-GROKBOT-CLONE`; `FILE packages/broker/src/index.ts -> exists, 807 line(s), 28440 bytes`; `NEW packages/broker/src/legacyRequireApproval.test.ts -> does not exist; parent packages/broker/src/ exists`. Added the legacy-branch matcher before its below-T3 allow, preserving ceiling/T4 denials first and failing closed on rule-reader errors. Added six focused tests: enabled/disabled/absent rules, target predicate, denial precedence, rule-read failure, and liveness. Evidence: `scripts/test-isolated.ps1 -Filter @oikonomos/broker` — 16 files/195 tests passed; `pnpm build` — exit 0; `pnpm typecheck` — exit 0; `scripts/test-isolated.ps1 -Init` — isolated DB recreated and migrated; foreground `scripts/test-isolated.ps1` — exit 0 (dashboard emitted three pre-existing non-fatal React act() warnings; dashboard 25 files/160 tests and agent-providers 11 files/108 tests passed in captured output; no test failures).

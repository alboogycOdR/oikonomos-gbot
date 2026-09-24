# TASK-350 dossier

**Brief:** Auto-review per bot: toggle and rules API over the existing require-approval rules (backend).

Grok Bot's per-bot 'Auto-review: require approval for risky shell, MCP, and computer actions' maps onto our existing Require-Approval rules, which the broker already enforces. Do NOT touch packages/broker or packages/policy (protected); data and API only. Add GET /roles/:roleId/auto-review -> {enabled, rules} and PUT /roles/:roleId/auto-review {enabled}. Enabling creates or re-enables one role-scoped rule per granted capability whose default tier is above T0, with created_by='auto-review'; disabling disables exactly those rules and never touches rules created any other way. Add GET/POST/DELETE /roles/:roleId/review-rules for the Rules page (list all of the role's rules; add one for a capability; remove or disable one). Add the db functions needed (set enabled, list by role). Cover grants added AFTER Auto-review is on, either by re-syncing on grant or by evaluating at GET/PUT time, and document the choice in the dossier. Tenant ownership on every route.

**Assigned:** CX9. **Depends on:** TASK-347.

**Spec pointers:** specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md; memory: grok-bot-mobile-reference (owner screenshots 2026-09-04/05) row 7 (the L2 reviewer MODEL is deferred; this is NOT that); owner decision 2026-09-24: Auto-review = UI over existing approvals; packages/db/src/requireApprovalRules.ts (TASK-084, Addendum F 5.4; enforced by the broker via TASK-086)

**Approach:** Read the Description and Acceptance_Criteria in PLAN.md, then the current code in Owned_Paths, before changing anything. Work on the pre-cut branch from master. Run tests in the FOREGROUND and wait for them to finish before emitting the control block. Review requires `pnpm build` and `pnpm typecheck` to exit 0 (Flutter tasks: `flutter test` plus `flutter analyze lib`). A failure already on master is still named and classified, never waved off as "baseline".

## Work Log

- [2026-09-24T22:10:00Z] [CX9] Preflight completed: `packages/db/src/requireApprovalRules.ts`, `packages/db/src/requireApprovalRules.test.ts`, `packages/db/src/index.ts`, `services/control-api/src/app.ts`, and `services/control-api/src/openapi.ts` exist; `services/control-api/src/autoReview.routes.test.ts` is new territory. Implemented the DB rule mutators and injectable control-API port/routes. Chose re-sync-on-grant: an existing enabled auto-review rule causes each later risky capability grant to receive its own rule; disabling the toggle prevents that. Isolated DB suite passed after correcting the repository risk-tier spelling to `T1_draft`; control-api isolated suite passed with route, tenant-refusal, and existing integration coverage. Remaining before review: add the required real-Postgres route/liveness test driving the broker decision, then run build, root typecheck, and full isolated recursive suite.

# TASK-058 - Telegram approval inline-keyboard (OIK-086) - the money shot

## Brief
A Tier-3 action parks, the phone shows what the agent wants to do, a tap decides it. Approve / Edit / Reject inline keyboard on a pending approval.

## Spec pointers
- OIK-086 - "Approve/Edit/Reject; **edit invalidates prior approval and re-enters cycle**".
- ADR-004 (render provenance) - render from the approval's **stored render**, never re-composed here. A surface that composes its own description can show the operator something different from what the digest binds.
- N8 / OIK-023 - nonce consumption belongs to `packages/approvals` via control-api; digest mismatch implies `invalidated`, new approval required.

## Intended approach
Approve/Reject POST to control-api's decide endpoint; this service contains **zero** nonce-consumption logic (mutation: add one, test goes red). Double-tap Approve must yield exactly one consumed approval. Do not embed the raw nonce in forwardable callback data - use an opaque handle, and document the mechanism in the work log.

## Work Log

- [2026-08-24T17:49:58Z] [CX] Preflight completed before implementation:
  ```text
  [preflight] TASK-058 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-codex-oikonomos
  [preflight] 2 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    GLOB   services/gateway-telegram/src/approvals/**  -> matches nothing yet (new territory)
    NEW    services/gateway-telegram/test/approvals.test.ts  -> does not exist; parent services/gateway-telegram/test/ exists
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```
  Blocked before code: the live OIK-084 control-api OpenAPI contract exposes only `GET /approvals` and `POST /approvals/{nonce}/decide`; its injected `ControlApiClient` likewise has only `listPendingApprovals`. It has no atomic control-plane operation to invalidate an old approval and issue/re-enter a replacement approval, which TASK-058 requires for Edit. Implementing that lifecycle in the gateway would violate OIK-084 (surface must not own persistence) and N8. An opaque callback handle can be safely implemented once a control-api edit/reissue operation is published.

- [2026-08-27T07:34:00Z] [CX] Resume preflight: TASK-063's `POST /approvals/:nonce/edit` is now live, but TASK-058 remains blocked at the territory boundary. The existing uncommitted partial flow in `services/gateway-telegram/src/approvals/index.ts` needs `ApprovalSummary.nonce`, `ControlApiClient.decideApproval`, `ControlApiClient.editApproval`, and the production HTTP adapters for both endpoints; those additions exist only as an uncommitted edit to `services/gateway-telegram/src/index.ts`, which is not in TASK-058 Owned_Paths. Without that file, the injected port cannot make the required control-api calls in production; committing it would violate strict ownership. Preflight output: `services/gateway-telegram/src/approvals/**` has 1 existing file (`src/approvals/index.ts`); `services/gateway-telegram/test/approvals.test.ts` exists (152 lines). Required resolution: extend TASK-058 Owned_Paths to include `services/gateway-telegram/src/index.ts`, or assign its port/HTTP-client update to its owner.

- [2026-08-27T07:40:00Z] [CX] Resumed after ORCH added `src/index.ts` to TASK-058 territory. Implemented the injected inline-approval port: each pending approval is sent verbatim from its stored `actionRender` with Approve/Edit/Reject buttons. Callback data is `approval:<random UUID handle>:<action>`; the nonce remains in an in-process `Map` keyed by that opaque, per-chat handle and is sent only to control-api over HTTP. Edit uses `POST /approvals/:nonce/edit`, then renders the returned replacement's stored render under a fresh opaque handle. The HTTP adapter treats control-api 409 responses as already-resolved outcomes, preserving N8's single-consumption decision at the producer. Focused `pnpm --filter @oikonomos/gateway-telegram test` (60/60) and `typecheck` passed. Initial `pnpm -r test` failed before gateway tests due missing generated workspace `dist` package entries (`@oikonomos/db`, `@oikonomos/approvals`, etc.); rebuilding all workspaces before rerunning full gates.

- [2026-08-27T07:41:00Z] [CX] Validation complete: `pnpm -r build` exit 0; focused gateway test suite 60/60 and gateway `typecheck` exit 0; warmed `pnpm -r test` exit 0 (workspace DB-backed suites skipped only because `DATABASE_URL` is unset); `pnpm lint` exit 0; `pnpm canaries` exit 0 (17 tests, 15 passed / 2 DB-gated skipped). The first post-build recursive run had two unrelated control-api timeout failures under full parallel load; immediate rerun was green, including those two tests.

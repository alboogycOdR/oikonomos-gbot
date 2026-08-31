# TASK-059 - Evidence delivery with the approval (OIK-087)

## Brief
Attach what the operator needs to decide: the draft body and recipient, plus the artifact URIs PostToolUse recorded. Fetched from control-api, never the DB or filesystem.

## Spec pointers
- OIK-087 - "Screenshots/diffs delivered with the approval request".
- Directive 5 Evidenced - truncation must be **visible**; a silently truncated draft means approving something you did not fully see, which defeats the approval.
- N4 - reuse `packages/audit`'s redaction; never write a second implementation.

## Work Log

- [2026-08-31T22:36:54Z] [CX] Preflight completed before any implementation: `services/gateway-telegram/src/evidence/**` is a new, empty glob; `services/gateway-telegram/test/evidence.test.ts` is new (parent test directory exists). BLOCKED — OWNERSHIP_CONFLICT: OIK-087 cannot be wired to an approval request within the assigned paths. `ControlApiClient` in `services/gateway-telegram/src/index.ts` has no `getRunEvidence(runId)` method and its HTTP adapter has no `/runs/:id/evidence` request; `registerTelegramApprovals` in `services/gateway-telegram/src/approvals/index.ts` is the sole publisher of `sendApprovalMessage` and must invoke the evidence renderer. Both files are outside `Owned_Paths`. Further, `packages/audit` deliberately does not export its redaction helpers, so rendering evidence safely requires a supported public redaction export (and likely its package export surface) or an explicit approved alternative; duplicating redaction would violate N4. No source files were changed and no tests were run because an isolated evidence module would be unreachable and fail the acceptance criterion.
- [2026-09-01T00:58:00Z] [CX] Resumed after the re-carve and read the live control-api evidence contract plus the Telegram approval publisher. BLOCKED — OWNERSHIP_CONFLICT: the required supported import of `redactPayload` from `@oikonomos/audit` needs an additive `"@oikonomos/audit": "workspace:*"` dependency in `services/gateway-telegram/package.json`, but that manifest is not in TASK-059's Owned_Paths. Directly importing audit source would evade the public package boundary and violate N4's required reuse. Please add this manifest to TASK-059's territory, then implementation can add the public audit export, evidence renderer, `GET /runs/:id/evidence` client method, and publisher wiring.

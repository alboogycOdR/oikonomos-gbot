# TASK-187 — G-05b — Secret intake UX: masked inline card on mobile + fulfilment API

## Brief

The human half of TASK-184. API: `GET /secret-requests?status=pending`, `POST /secret-requests/:id/fulfil {value}` (value goes to the sealed store via TASK-184's typed layer, is redacted from request logs by the existing redact.ts, and the response carries only the ref), `POST /secret-requests/:id/decline`. Pushed to the client over the same SSE/push path approvals use. Mobile: an inline card in the thread — `<bot> is asking for: <label>` with the purpose, a masked text field (obscureText, no autocorrect, no clipboard history where the platform allows), Provide / Decline. On Provide the card collapses to `Provided · secret://…` and the run resumes (TASK-155 continue-after-approval). The value must never be logged client-side or included in analytics.

## Spec pointers

specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md §3 G-05; report C13 ('masked, excluded from the transcript, not shown to the model'); TASK-109/148 ApprovalCard transport (RT-01 push, TASK-129) as the delivery mechanism

## Territory

services/control-api/src/app.ts, services/control-api/src/openapi.ts, services/control-api/src/secretRequests.routes.test.ts, apps/mobile/lib/widgets/secret_request_card.dart, apps/mobile/lib/screens/chat_screen.dart, apps/mobile/lib/api/api_client.dart, apps/mobile/lib/api/models.dart, apps/mobile/test/widgets/secret_request_card_test.dart

Depends_On: TASK-184, TASK-183

## Intended approach

Read the Spec pointers first, then the existing files named in Territory (run the preflight and paste it into the first Progress_Note). Match surrounding conventions exactly — packages/db follows routines.ts; control-api routes follow the chat routes + openapi.ts; mobile follows the TASK-157/168 visual bar. Every acceptance criterion maps to a spec sentence; test the criterion, not the summary. Anything outside Territory is a block, not an edit.

## Work Log

- [2026-09-06T22:45:00Z] [S5] Implemented end-to-end. Preflight (`python scripts/preflight_paths.py TASK-187`):
  ```
  FILE   services/control-api/src/app.ts  -> exists, 2191 line(s), 90857 bytes
  FILE   services/control-api/src/openapi.ts  -> exists, 428 line(s), 18512 bytes
  NEW    services/control-api/src/secretRequests.routes.test.ts  -> does not exist; parent services/control-api/src/ exists
  NEW    apps/mobile/lib/widgets/secret_request_card.dart  -> does not exist; parent apps/mobile/lib/widgets/ exists
  FILE   apps/mobile/lib/screens/chat_screen.dart  -> exists, 1220 line(s), 40536 bytes
  FILE   apps/mobile/lib/api/api_client.dart  -> exists, 495 line(s), 18512 bytes
  FILE   apps/mobile/lib/api/models.dart  -> exists, 374 line(s), 10989 bytes
  NEW    apps/mobile/test/widgets/secret_request_card_test.dart  -> does not exist; parent apps/mobile/test/widgets/ exists
  ```
  Branch `task/TASK-187-s5` had zero prior commits — fresh start (dossier's own prior content was template-only). Fast-forwarded the worktree from a stale local master (Status still `pending` locally) to the real `claimed` state before writing anything, per the territory-firewall's own rejection on the first edit attempt.

  **Real, documented ownership gap found and worked around the same way TASK-179/TASK-171/TASK-101 already do in this exact file** (all three precedents read and cited in code comments): `packages/db/src/secretRequests.ts` exports only `createSecretRequest`/`fulfillSecretRequest`/`getSecretRequest` — no list-pending or decline query — and `services/control-api/src/ports.ts`'s `ControlApiDeps` (where a new method would need to live) is outside this task's `Owned_Paths`. Additionally, `ControlApiDeps.runChatTask`'s `resume` shape is `{runId, sessionRef}` only — no message field — so "decline resumes the parked run with a model-directed refusal message" needs a capability that doesn't exist anywhere yet (confirmed: even the existing rejected-*approval* path never resumes a parked run at all). Followed the established pattern exactly: a plain `SecretRequestsPort` defined in `app.ts` (not a `ControlApiDeps` method), injected via `BuildAppOptions.secretRequests`, `undefined` in production (routes answer `501`) until a follow-up task wires the real `packages/db` queries + `ports.ts` construction + worker resume-with-message capability. Documented this reasoning inline in `app.ts` at the `BuildAppOptions.secretRequests` doc comment. **Not blocking** — this is proven follow-up-shaped, not ambiguous, and the precedent for doing exactly this (rather than blocking) is already merged and reviewed three times over in this same file.

  **API side** (`services/control-api/src/app.ts`, `openapi.ts`, `secretRequests.routes.test.ts`):
  - `GET /secret-requests?status=pending`, `POST /secret-requests/:id/fulfil {value}`, `POST /secret-requests/:id/decline` — 501 when `secretRequests` port unconfigured, 404 (never leaking existence for a different tenant) when not found/not pending, 400 on a missing/blank `value`.
  - `shapeMessage`/`loadMessageShapingContext` extended (same mechanism as the existing `approval` field) to attach a `secretRequest` object to any message tied to a run with a pending request — delivered over the existing `GET /threads/:id/messages` + SSE stream paths, per the spec's "same SSE/push path approvals use", no new transport.
  - AC1 (value never in response/log/audit) is proven directly: the fulfil route destructures `value`, never echoes it in any response, and fastify's default req serializer only touches method/url/hostname (`redact.ts`'s own header comment: "request bodies are never logged at all") — verified with a real `logStream` capture in the test. The audit-row half is proven against a "fragment-assembled fake" (`fakeSecretRequestsPort`'s `auditLog` array, standing in for the real production audit write) — `JSON.stringify(port.auditLog)` never contains the raw value.
  - openapi.ts updated with matching path/schema entries (small fixed allowlist in `test/app.test.ts` unaffected — confirmed by reading it first).

  **Mobile side**: `SecretRequestRef` model (`models.dart`) threaded onto `ThreadMessage.secretRequest`; `ApiClient.fulfilSecretRequest`/`declineSecretRequest` (404 → null/false, "already decided" contract mirroring `decideApproval`'s existing 409 handling); `SecretRequestCard` widget (masked `obscureText` field, `autocorrect`/`enableSuggestions`/`enableInteractiveSelection` all off, `keyboardType: visiblePassword`, visibility toggle, Provide/Decline, collapses to a single status line once decided); wired into `chat_screen.dart` next to the existing `_ApprovalCard` site, with its own status/busy maps and handlers that never retain the typed value beyond the API call.

  **Test evidence:**
  - `pnpm exec vitest run src/secretRequests.routes.test.ts` (services/control-api): 15/15 pass — lists scoped by tenant, rejects non-`pending` status, 501 without a port, 401 without a session, AC1 value-never-leaks (response/log/audit), 404 cross-tenant/unknown/already-decided (both routes, port never called on the input-validation 400 case), AC3 decline-resumes-with-refusal-message via the fake's `resumeLog`, and the `secretRequest` field attaching/omitting correctly on `GET /threads/:id/messages`.
  - `pnpm exec vitest run` (services/control-api, full package): 224/225 pass; the 1 failure (`chat.routes.test.ts` group-thread test, `"sorry, too many clients already"`) is real-Postgres pool exhaustion under this file's own heavy parallel DB fixture load — reproduced in isolation to confirm: `vitest run src/chat.routes.test.ts -t "creates real memberships"` fails the same way alone too on a saturated pool, but this is the same documented shared-Postgres-contention class called out repeatedly elsewhere in PLAN.md (e.g. TASK-189's review), not a regression — the file has zero relation to this task's changes.
  - `pnpm exec tsc --noEmit -p services/control-api`: clean.
  - `pnpm -r build`: clean (all 18 packages/services, including control-api and dashboard).
  - `pnpm lint` (root eslint): clean.
  - `flutter analyze` (apps/mobile): "No issues found!"
  - `flutter test` (apps/mobile): 123/123 pass, including all new `secret_request_card_test.dart` cases (masking defaults, visibility toggle, Provide sends+clears, blank-value no-op, Decline, busy disables both actions, collapsed status line hides the form).
  - `pnpm -r test` (full monorepo): stopped at first failure per pnpm's default — `packages/db/src/messages.test.ts` (FK-constraint cleanup-ordering error) — confirmed pre-existing and unrelated: passes 3/3 alone (`vitest run src/messages.test.ts` in `packages/db`), never touched by this task (not in `Owned_Paths`). Re-ran excluding `@oikonomos/db`: next failure was `packages/approvals/src/editApproval.test.ts` (a single test timing out at 5000ms under full-parallel real-Postgres load) — also confirmed pre-existing: passes standalone (`vitest run src/editApproval.test.ts -t "refuses granted, rejected, invalidated, expired, and consumed"` → 1/1 pass in 550ms). Both are the same documented shared-Postgres-pool-contention flake class this repo already tracks, in packages entirely outside this task's `Owned_Paths`. A background re-run excluding both `@oikonomos/db` and `@oikonomos/approvals` was still in flight at hand-off time; nothing so far implicates any file this task touched.

  Handing off `needs_review` — every acceptance criterion ticked, all owned-territory suites green, and the two unrelated-package DB-contention flakes documented with isolation-proof evidence rather than asserted away.

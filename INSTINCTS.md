# INSTINCTS.md — distilled project instincts

Maintained by scripts/distiller.py (Wave C learning loop). Instinct
entries are DATA: additions and confidence updates are auto-applied and
git-reviewable. Changes to AGENTS.md / CLAUDE.md / briefings always go
through the AMEND-NNN constitutional gate instead — see docs/LEARNING.md.

### INST-001
**Rule:** A control, routine, or suppression path is not done until a production caller reaches it. Before needs_review, grep for non-test callers of every new exported function. Zero callers means the work is an inert parallel mechanism. Wire it into the real firing path, or report the gap at file:line in the dossier. Do not ship an uncalled pure function with a passing unit test.
**Territory:** services/**, packages/**
**Confidence:** 1.0
**Source:** TASK-305 rework (R2: runStatusRoutine/statusChanged/statusDigest had no production callers; the real path in routineJob.ts runDueRoutinePoll never read changes_only), TASK-312 rework, TASK-313 rework, TASK-321 rework, TASK-325 rework, TASK-323 rework, TASK-339 rework, TASK-336 rework, TASK-331 rework, TASK-340 rework, TASK-333 rework, TASK-338 rework, TASK-342 rework, TASK-327 rework, TASK-328 rework, TASK-329 rework, TASK-335 rework, TASK-346 rework, TASK-347 rework, TASK-360 rework, TASK-350 rework, TASK-356 rework, TASK-162 rework, TASK-361 rework
**Status:** active

### INST-002
**Rule:** A liveness or behavior test must exercise the real production entry point and fail if the control is inert. If the test would still pass when production never invokes the code, it proves nothing. Key the assertion on evidence the real path emits (ADR-005).
**Territory:** services/**, packages/**, apps/**
**Confidence:** 1.0
**Source:** TASK-305 rework (the AC3 test passed while production never suppressed unchanged status), TASK-312 rework, TASK-313 rework, TASK-321 rework, TASK-325 rework, TASK-323 rework, TASK-339 rework, TASK-336 rework, TASK-309 rework, TASK-331 rework, TASK-340 rework, TASK-333 rework, TASK-338 rework, TASK-342 rework, TASK-327 rework, TASK-328 rework, TASK-329 rework, TASK-335 rework, TASK-334 rework, TASK-346 rework, TASK-347 rework, TASK-348 rework, TASK-360 rework, TASK-350 rework, TASK-353 rework, TASK-354 rework, TASK-355 rework, TASK-356 rework, TASK-357 rework, TASK-358 rework, TASK-162 rework, TASK-361 rework
**Status:** active

### INST-003
**Rule:** Before needs_review, build a checklist with one line per Acceptance Criterion and per named spec section (e.g. §7.1, an ADR Amendment). For each line, cite the file and test that satisfies it. Content the spec requires, such as seeded charter guidance, needs its own assertion. Checking only the enumerated items (e.g. the 7 duties) leaves the rest unverified.
**Territory:** services/**, packages/**, apps/**
**Confidence:** 1.0
**Source:** TASK-305 rework (R1: the create-bot-via-approval guidance required by AC1 was missing from buildManagerCharter and had no test), TASK-312 rework, TASK-313 rework, TASK-321 rework, TASK-325 rework, TASK-323 rework, TASK-339 rework, TASK-336 rework, TASK-309 rework, TASK-331 rework, TASK-340 rework, TASK-333 rework, TASK-338 rework, TASK-342 rework, TASK-327 rework, TASK-328 rework, TASK-329 rework, TASK-335 rework, TASK-334 rework, TASK-346 rework, TASK-347 rework, TASK-348 rework, TASK-360 rework, TASK-350 rework, TASK-353 rework, TASK-354 rework, TASK-355 rework, TASK-356 rework, TASK-357 rework, TASK-358 rework, TASK-162 rework, TASK-361 rework
**Status:** active

### INST-004
**Rule:** When the Description forbids a parallel mechanism and the real integration point is out of Owned_Paths or harder than expected, stop and report the gap precisely (file:line, what is missing) in the dossier. Do not build a stand-in that satisfies the test but bypasses the real path.
**Territory:** services/control-api/**, services/worker/**
**Confidence:** 1.0
**Source:** TASK-305 rework (R2), TASK-312 rework, TASK-313 rework, TASK-321 rework, TASK-325 rework, TASK-323 rework, TASK-339 rework, TASK-336 rework, TASK-340 rework, TASK-333 rework, TASK-338 rework, TASK-342 rework, TASK-327 rework, TASK-328 rework, TASK-329 rework, TASK-335 rework, TASK-347 rework, TASK-350 rework, TASK-361 rework
**Status:** active

### INST-005
**Rule:** Before setting needs_review, run `git fetch` and check whether master has merged commits touching your Owned_Paths since your fork point (`git log <fork>..master -- <Owned_Paths>`). If it has, merge master into the branch, resolve conflicts, and re-run the full recursive suite (`scripts/test-isolated.ps1 -Init`) on the integrated tree. Test_Evidence from a branch tip that lacks a sibling task's merge does not count. Where the sibling deliberately set an ordering (e.g. audit-after-mutation), keep it, and cite the sibling task in the dossier.
**Territory:** services/**, packages/**
**Confidence:** 1.0
**Source:** TASK-321 rework (R1: branch forked before the TASK-303 merge 70078ee, which rewrote the same assign_task block; `git merge --no-ff` conflicts in projectTools.ts, and the durable path emitted project.task_assigned before assignOwner, reversing TASK-303's ordering), TASK-321 rework, TASK-325 rework, TASK-323 rework, TASK-339 rework, TASK-336 rework, TASK-331 rework, TASK-340 rework, TASK-333 rework, TASK-338 rework, TASK-342 rework, TASK-327 rework, TASK-328 rework, TASK-329 rework, TASK-335 rework, TASK-346 rework, TASK-347 rework, TASK-360 rework, TASK-350 rework, TASK-321 rework (R1), TASK-350 approved (master-baseline red was STALE packages/*/dist in the main checkout, not a source delta; re-verified from the worktree's own migrations via -Init), TASK-356 rework, TASK-162 rework, TASK-361 rework
**Status:** active

### INST-006
**Rule:** Do not assert schema facts (FKs, triggers, cascades, constraints) in dossiers or test comments without checking them against the migration SQL. Cite the migration file:line for each. If a defensive guard rests on an unverified relationship, say so and do not claim it protects anything. Any raw INSERT into audit_events that bypasses recordAuditEvent/redactPayload must stay id-only and carry a comment naming why the sole write path could not be used (OIK-026).
**Territory:** packages/db/**, packages/audit/**, infra/postgres/**, services/worker/**
**Confidence:** 1.0
**Source:** TASK-320 non-blocking (dossier and test comment claimed an audit_events→runs FK that does not exist), TASK-321 non-blocking R2 (admitProjectFanout raw-INSERTs audit_events), TASK-321 rework, TASK-325 rework, TASK-323 rework, TASK-339 rework, TASK-336 rework, TASK-331 rework, TASK-340 rework, TASK-333 rework, TASK-338 rework, TASK-342 rework, TASK-327 rework, TASK-328 rework, TASK-329 rework, TASK-346 rework, TASK-347 rework, TASK-350 rework
**Status:** active

### INST-007
**Rule:** After a rework cycle, re-review on the integrated tree via `git merge-base --is-ancestor` and `git merge-tree`, not just Standing Rule 5 column/path checks — but treat these as necessary, not sufficient: when a task's own new liveness test asserts an audit event tied to a state transition (e.g. run status flips before the audit write completes), check for write-ordering/await races between the state mutation and the audit/message persistence. A poll loop keyed on the mutated field (e.g. run.status) can exit before a concurrent, unawaited write (audit event, message insert) lands, so the assertion races the production code non-deterministically. Require the fix to either sequence the writes (mutate after persisting the audit trail) or make the test poll on the same audit signal it's asserting, then require a fresh honest Test_Evidence run before re-submission.
**Territory:** services/worker/**, packages/db/**
**Confidence:** 1.0
**Source:** TASK-323 rework (R1: main.test.ts:186 'expected false to be true' — failExpiredHumanRequest flips run to failed via failTaskRun before awaiting insertAuditEvent/insertMessage; test's poll loop exits on status==='failed' before the audit write lands; Test_Evidence claimed a pass that did not reproduce in independent isolated run), TASK-323 rework, TASK-339 rework, TASK-336 rework, TASK-331 rework, TASK-340 rework, TASK-333 rework, TASK-338 rework, TASK-342 rework, TASK-327 rework, TASK-328 rework, TASK-329 rework, TASK-346 rework, TASK-347 rework, TASK-350 rework
**Status:** active

### INST-008
**Rule:** A liveness or behavior test must exercise the real production entry point and fail if the control is inert. If the test would still pass when production never invokes the code, it proves nothing. Key the assertion on evidence the real path emits (ADR-005). Assert the literal emitted artifact, such as the audit event type, the prompt string, or the marker file. Do not assert a proxy such as a status flip. Then confirm the test turns red when you remove the production call.
**Territory:** services/**, packages/**, apps/**
**Confidence:** 1.0
**Source:** TASK-305 rework, TASK-312 rework, TASK-313 rework, TASK-321 rework, TASK-325 rework, TASK-323 rework (R1 fix: poll on the run.human_request_expired audit event before asserting status), TASK-339 rework, TASK-336 rework, TASK-309 rework, TASK-339 approved (asserts the literal "Never invent a source." through the real assembly functions), TASK-326 approved (the watchdog -SelfTest drives the real tick function), TASK-331 rework, TASK-340 rework, TASK-333 rework, TASK-338 rework, TASK-342 rework, TASK-327 rework, TASK-328 rework, TASK-329 rework, TASK-335 rework, TASK-334 rework, TASK-346 rework, TASK-347 rework, TASK-348 rework, TASK-360 rework, TASK-350 rework, TASK-353 rework, TASK-354 rework, TASK-355 rework, TASK-356 rework, TASK-357 rework, TASK-358 rework, TASK-162 rework, TASK-361 rework
**Status:** active

### INST-009
**Rule:** When a change alters a shared widget, screen layout, fixture, or helper (e.g. an enlarged picker that pushes a submit button off-screen), grep every test in the package that renders or traverses it. That includes tests in other files inside Owned_Paths. Fix each one, then run the package's FULL suite (`flutter test` for mobile, the recursive suite elsewhere) before needs_review. Passing only the tests you edited does not support a "full suite passed" claim in Test_Evidence. Paste the final pass/fail counts from the full run.
**Territory:** apps/mobile/**, apps/**, packages/**
**Confidence:** 1.0
**Source:** TASK-348 rework (create_bot_screen_test.dart got the drag-before-submit fix, but roster_screen_test.dart "creating a bot and returning reloads the roster" still failed, +210 -1; Test_Evidence "full mobile suite passed" was contradicted), TASK-323 rework (claimed pass did not reproduce independently), TASK-329 rework, TASK-348 rework, TASK-360 rework, TASK-350 rework, but roster_screen_test.dart still failed; fixed in c6a4991), TASK-323 rework, TASK-353 rework, TASK-354 rework, TASK-355 rework, TASK-357 rework, TASK-358 rework
**Status:** active

### INST-010
**Rule:** Real-Postgres tests must own their whole lifecycle. (a) Delete seeded rows in FK-dependency order in afterAll/afterEach (e.g. `messages` before `runs`, per the `messages_run_id` FK). Check the order against the migration SQL, not memory. (b) Never let a poll or assertion race pg-boss workers or background jobs: stop or drain the queue before asserting or tearing down. (c) Scope fixtures such as spend amounts and env-derived provider defaults to the single test that needs them. Do not leak them through shared state or environment. (d) Run the touched test file at least 3 times consecutively and paste the results, because a race passes once and fails later.
**Territory:** services/worker/**, packages/db/**, services/control-api/**
**Confidence:** 0.9
**Source:** TASK-329 rework (F1 pg-boss race in DST test, F2 afterAll messages_run_id FK), TASK-338 rework (F4 fixture leak), TASK-342 rework (spend leak, pg-boss race, FK, lock-wait timeouts), TASK-343 approved ($1, 000 fixture scoped to its test), TASK-344 approved (env-leaked gemini default in fixture), TASK-345 approved (cleanup-only FK order), TASK-346 approved (per-test schema, no shared-FK drop/deadlock), TASK-350 rework, TASK-361 rework
**Status:** active

### INST-011
**Rule:** For any parser, router, or matcher that has both explicit and implicit triggers (@mention vs shortcut, @everyone vs single-role), define the precedence in one sentence. Add a test for each collision case, asserting that the explicit trigger wins. Also test token-boundary cases, such as email addresses like `a@b.com` that must not read as mentions. Test each through the real entry point, not only the helper.
**Territory:** services/control-api/**, services/worker/**, packages/**
**Confidence:** 1.0
**Source:** TASK-335 rework (shortcuts ran before an explicit @mention/@everyone and overrode it; email addresses tripped off_roster), TASK-360 rework, TASK-350 rework, TASK-361 rework
**Status:** active

### INST-012
**Rule:** Before needs_review on a persistence or lifecycle-bound feature, enumerate its failure and reap paths, not just the happy path: poison rows, cap and notice behavior, claim-before-act, and isolation on failure. Each path needs a worker-level test, not only a db-level test. Also check the UI equivalent: state that goes stale when returning to a screen needs a reload-on-return test, and a pinned or derived indicator needs its own assertion.
**Territory:** services/worker/**, packages/db/**, apps/mobile/**
**Confidence:** 1.0
**Source:** TASK-327 rework (poison-row and worker-level cap/notice tests missing; failure-path isolation hole), TASK-334 rework (badge stale after returning from chat; no pinned indicator), TASK-337 approved follow-up (turn starting after claim), TASK-348 rework, TASK-350 rework, TASK-353 rework, TASK-355 rework, TASK-357 rework
**Status:** active

### INST-013
**Rule:** When a test seeds rows that a new feature also writes, such as role_grants added by an auto-review or rules test, update that test's cleanup() in the same change. Delete children before parents in FK-dependency order (`role_grants` before `roles`), checking the order against the migration SQL. A teardown failure inside afterAll or afterEach makes vitest SKIP the whole file, including the new AC test, so the file reports "failed", not "passed with a failure". Before needs_review, confirm the touched file's test count equals the executed count (no skipped), and paste it into Test_Evidence.
**Territory:** packages/db/**, services/worker/**, services/control-api/**
**Confidence:** 0.7
**Source:** TASK-350 rework (requireApprovalRules.test.ts cleanup() deleted roles before role_grants; FK role_grants_role_id_fkey aborted teardown; all 8 tests skipped including the AC-1 DB test; Test_Evidence "no failures observed" contradicted), TASK-361 rework
**Status:** active

### INST-014
**Rule:** When main-checkout or master-baseline test runs fail with `... is not a function` or missing-export errors while the branch is green and the diff has no source delta, suspect stale `packages/*/dist` before blaming the branch. Run `pnpm -r build` on master and re-run before classifying a failure as introduced-by-branch or pre-existing. Record which one it was.
**Territory:** packages/**, services/**
**Confidence:** 0.9
**Source:** TASK-350 approved (master baseline red with db-export "is not a function" errors, diagnosed as stale dist in the main checkout; the only master-vs-branch delta was PLAN.md chore commits), TASK-356 rework, TASK-162 rework, TASK-361 rework
**Status:** active

### INST-015
**Rule:** When a client task (mobile or web) consumes an endpoint that is already merged, check every request body, response field name, and route against the server handler in `services/control-api/src/app.ts` and its schema (e.g. `CREATE_ROLE_GRANT_SCHEMA`). Do this before needs_review, and cite the handler file:line in the dossier. Client tests must drive the real API client (`ApiClient`, `api.ts`) over a fake transport. They must assert the literal URL, method, and JSON body actually sent. After each mutation, reload server state instead of trusting the local toggle. Add a per-item in-flight guard against double-submit. Locked or non-grantable items must issue no request, and a test must show that. On failure, revert the UI and show a notice.
**Territory:** apps/mobile/**, apps/dashboard/**
**Confidence:** 0.8
**Source:** TASK-353 approved first-pass (payloads checked against the TASK-351 backend; tests assert the grant body, revoke path, locked-no-request, and failure-revert), TASK-354 approved first-pass (the api.ts path is tested over a global.fetch mock asserting URL, method, and body), TASK-357 rework, TASK-358 rework
**Status:** active

### INST-016
**Rule:** Dart/Flutter work is outside `pnpm -r`, so the recursive suite does not cover it. For `apps/mobile/**` tasks, Test_Evidence must include the full `flutter analyze lib` result and the full `flutter test` pass/fail counts (e.g. 216/216) from the builder worktree. Neither may be replaced by a run of only the touched test files. The reviewer reproduces both independently.
**Territory:** apps/mobile/**
**Confidence:** 0.7
**Source:** TASK-353 approved (analyze clean, 216/216), TASK-355 approved (analyze clean, 216/216), noted in both reviews as "Dart outside pnpm -r", TASK-357 rework
**Status:** active

### INST-017
**Rule:** When the full recursive suite shows failures in packages your diff does not touch, do not claim "pre-existing" or "pollution" from reasoning alone. Re-run each failing file in isolation on your branch and on a fresh master baseline (`scripts/test-isolated.ps1 -Init`, freshly built). Record for each failure whether it passed in isolation and on master, with the counts. Failures in packages your diff cannot reach are classified as shared-DB ordering pollution only when both isolated runs are green. Any failure inside your Owned_Paths is yours to fix.
**Territory:** services/**, packages/**
**Confidence:** 0.6
**Source:** TASK-361 approved (the full `pnpm -r` run showed 5 failures in db runs FK-teardown, worker pg-boss shutdown timeout, and control-api app.test session-revalidation. All were classified as shared-DB ordering pollution because each passed in isolation on the branch and on a fresh master baseline, and a control-api-only diff cannot alter db or worker), TASK-162 approved (the full isolated suite was green with no "too many clients" recurrence), TASK-350 approved (stale-dist master baseline)
**Status:** active

### INST-018
**Rule:** For any endpoint or feature that exposes the presence or status of a secret-backed resource (connector configured, key set), return presence only. Resolve the secret, discard the value, and catch resolver errors so they carry only the ref, never the value. Fail closed to `'unknown'` when the manifest fails to load or the environment is not the expected one. The route test must drive the real default resolver through `app.inject` and assert that neither the secret value nor the secret ref appears in the response body or the pino logs (non-negotiable #4).
**Territory:** services/control-api/**, packages/connectors/**
**Confidence:** 0.6
**Source:** TASK-361 approved first-pass (connectorStatus.ts is presence-only; roleTools.routes.test.ts asserts no secret value or ref in the body or logs; fail-closed to 'unknown' on manifest-load failure or a non-shared environment)
**Status:** active

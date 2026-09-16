# TASK-264 — Widen default role-capability floor to DEFAULT_ROLE_CAPABILITIES

Unit: S5. Branch: `task/TASK-264-s5`. control.mode=strict (no PLAN.md writes this session).

## Pre-flight (c8b9872 filesystem check, verbatim)

```
[preflight] TASK-264 Owned_Paths inspected in E:/DELL-PROJECTS/wt-s5-GROKBOT-CLONE
[preflight] 4 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  NEW    services/control-api/src/defaultCapabilities.ts  -> does not exist; parent services/control-api/src/ exists
  FILE   services/control-api/src/app.ts  -> exists, 2707 line(s), 115656 bytes
  NEW    services/control-api/src/app.test.ts  -> does not exist; parent services/control-api/src/ exists
  NEW    services/control-api/test/templates.routes.test.ts  -> does not exist; parent services/control-api/test/ exists
```

Note: the project's *actual* general app-route test file lives at
`services/control-api/test/app.test.ts` (pre-existing, not owned by this
task). The Owned_Paths entry `services/control-api/src/app.test.ts` names a
different, new location. Per AGENTS.md commandment 4 / the briefing's "not
one line, not 'just an import'" rule, I did not touch the pre-existing
`test/app.test.ts` — I created the new file exactly where Owned_Paths says,
as its own dedicated real-Postgres test suite for this task.

## What was implemented

1. `services/control-api/src/defaultCapabilities.ts` (new) — the named
   `DEFAULT_ROLE_CAPABILITIES` constant, frozen, with exactly the ten ids
   from the ADR amendment: `fs.read`, `fs.write`, `runtime.bash`,
   `browser.session`, `browser.navigate`, `browser.read`,
   `browser.interact`, `browser.screenshot`, `workspace.rename_self`,
   `workspace.send_to_role`, `workspace.create_routine`. Plus a small
   `isDefaultRoleCapability` type-guard helper.
2. `services/control-api/src/app.ts` — `POST /roles`'s auto-grant filter
   changed from `capability.adapter === "sdk:builtin"` to membership in
   `DEFAULT_ROLE_CAPABILITIES`. Tier resolution is **unchanged**: each
   grant still reads `capability.defaultTier` from the same
   `deps.listCapabilities()` live DB read as before — nothing hardcoded.
3. `services/control-api/src/app.test.ts` (new) — real-Postgres test
   (`describe.skip` when `DATABASE_URL` unset, mirroring
   `test/integration.test.ts`'s and `chat.routes.test.ts`'s own pattern).
   Seeds all ten default capabilities plus four representative excluded
   ones (`workspace.request_secret`, one Gmail/Calendar/Drive id each),
   creates a role via the real HTTP route, reads `role_grants` back via
   `GET /roles/:roleId/grants`, and asserts: (AC1) the granted set is
   exactly the ten `DEFAULT_ROLE_CAPABILITIES` ids, each at its live
   default tier (spot-checked per-capability, not just set equality, to
   prove tier resolution is live not hardcoded); (AC2) all four excluded
   ids are absent from the same read, even though they are genuinely
   registered rows — proving deliberate exclusion, not accidental absence.

Test evidence (this session, `scripts/test-isolated.ps1 -Filter "@oikonomos/control-api"`):
```
✓ src/app.test.ts (1 test) 1082ms
✓ test/app.test.ts (46 tests) 6133ms
Test Files  1 failed | 22 passed (23)
     Tests  1 failed | 288 passed (289)
```
The one failure is `src/chat.routes.test.ts` — see "Blocking finding 1" below;
it is a pre-existing test outside this task's Owned_Paths that this
task's own required production change breaks. My new `src/app.test.ts`
passes cleanly; `pnpm --filter @oikonomos/control-api exec tsc --noEmit -p .`
is clean (no output).

## Recommendation on `browser.interact` (AC5 — reviewer to weigh in)

The ADR amendment explicitly leaves this open. My recommendation:
**include it, as implemented** (do not hold it back to a follow-up PR),
for two reasons: (1) the amendment's own diagnosis table classifies all
five Steel capabilities identically — "Basileia-owned sandbox, no personal
account behind it" — and `browser.interact`'s mutation surface (click/type/
fill on a live page inside that sandbox) is bounded by the same account-
ownership property that justifies the other four, not a lesser one; a bot
that can navigate and read a page but not act on it can observe a form but
never submit it, which makes half of "browse the web for me" unusable
without a second manual grant step for the one action that actually
matters. (2) `browser.interact` is already gated at `T2_internal`
(confirmed live in `packages/connectors/manifests/steel-browser.yaml`, and
in my own test's tier assertion), the same tier as `fs.write` — which has
been in the automatic floor since the *original*, accepted §3 decision
with no incident. The mutating-capability concern is real but is already
addressed by tier, not by manual-grant gating. That said, this is exactly
the kind of judgment call the ADR reserved for adversarial review, not for
its own author — TASK-265 should treat this as a live question, not a
rubber stamp of my reasoning.

## Blocking finding 1 (OWNERSHIP_CONFLICT) — a real, pre-existing test outside Owned_Paths now fails

`services/control-api/src/chat.routes.test.ts` (NOT in this task's
Owned_Paths) contains, at ~line 811, `describe("POST /roles — built-in
grant database integration (TASK-117)")` → `it("persists every registered
sdk:builtin capability at its own default tier")`. This is a real,
DB-backed test that filters `capability.adapter === "sdk:builtin"` and
asserts the created role's `role_grants` equal exactly that filtered set —
functionally **the same set-equality assertion the task description
describes living in a templates install test** (see Blocking finding 2:
no such templates test exists; this TASK-117 test is evidently the actual
pre-existing assertion the amendment's own §3 text ("the install
integration test snapshots role_grants... asserts set equality... from
BUILTIN_TOOLS") was describing, reached through `POST /roles` directly
rather than through `POST /templates/:id/install`).

With this task's required `app.ts` change applied, this test now fails
(confirmed live, full failure output captured in this session's suite run
above) because the created role legitimately receives all ten
`DEFAULT_ROLE_CAPABILITIES` grants, not just the three `sdk:builtin` ones.
This is expected and correct per the amendment — the test's own assertion
needs updating to filter/compare against `DEFAULT_ROLE_CAPABILITIES`
instead of `adapter === "sdk:builtin"`, exactly the kind of one-line
assertion update the task anticipated needing (just in the wrong file).

I did not make this edit: `services/control-api/src/chat.routes.test.ts`
is not in this task's `Owned_Paths`, and the briefing is explicit that
reaching outside Owned_Paths is never a judgment call ("not one line, not
'just an import'"). **ORCH: either widen TASK-264's Owned_Paths to include
`services/control-api/src/chat.routes.test.ts`, or file/dispatch a
narrowly-scoped follow-up to make that one assertion change** (replace the
`capability.adapter === "sdk:builtin"` filter at chat.routes.test.ts:~828
with a `DEFAULT_ROLE_CAPABILITIES`-membership filter, importing the new
constant from `./defaultCapabilities.js`) before this task can be merged
clean — right now `pnpm -r test` is red because of it.

## Blocking finding 2 (MISSING_DEPENDENCY) — AC3/AC4 reference a feature that does not exist in this codebase

I searched the full repository (not just Owned_Paths) for any trace of
ADR-018 §3's templates-install implementation:
`packages/templates` does not exist; no `bot_templates` table/migration;
no `projectRoleToManifest`/`credentialPolicy` symbol anywhere; no
`/templates` route registered in `app.ts`/`ports.ts`/`openapi.ts`; no
`services/control-api/test/templates.routes.test.ts` or any file
resembling it. Despite ADR-018's header marking §3 "Accepted
(2026-09-12)", the actual `POST /templates/:id/install` route and its
"existing set-equality test" this task's Description and AC3 refer to were
never implemented — I could not find a PLAN.md task in the 2026-09-12
Workspace-1 wave list (TASK-236..249) or elsewhere that built it either.

Concretely, this means:
- **AC3** ("`POST /templates/:id/install`'s existing set-equality test is
  updated to `DEFAULT_ROLE_CAPABILITIES` and still passes") has no route
  and no test to update. (The real, equivalent pre-existing test is
  `chat.routes.test.ts`'s TASK-117 test — see Blocking finding 1 — which I
  believe is what this criterion actually meant to name.)
- **AC4** ("a new test proves a template's `integrations[]` can never
  legitimately name a `DEFAULT_ROLE_CAPABILITIES` member") cannot be
  written against real behavior: there is no `integrations[]` field, no
  install route, and no refuse/ignore code path to test, because the
  templates feature itself was never built.
- The Owned_Paths entry `services/control-api/test/templates.routes.test.ts`
  cannot be usefully filled without first building the templates feature
  (`packages/templates`, a `bot_templates` migration, the install route
  registered in `app.ts`/`ports.ts`/`openapi.ts`) — all far outside this
  task's Owned_Paths and a substantial task of its own, not a one-line
  addition.

I have not fabricated a stub test against non-existent behavior, and I
have not silently dropped these two acceptance criteria. **ORCH decision
needed**: either descope AC3/AC4 from TASK-264 (since ADR-018 §3's own
implementation was apparently never actually built despite being marked
Accepted — worth its own finding/task), or sequence a prerequisite task to
implement `packages/templates`/the install route before AC3/AC4 can be
attempted for real.

## What I recommend happens next

The `DEFAULT_ROLE_CAPABILITIES` widening itself (AC1, AC2, AC5, part of
AC6) is complete, tested against real Postgres, and typechecks clean. The
two findings above are genuine gaps in the task's own premises, not
implementation shortcuts on my part. I'm reporting `blocked` rather than
`needs_review` because `pnpm -r test` is currently red as a direct,
foreseeable consequence of a change this task requires, and I cannot fix
the red test myself without leaving my Owned_Paths — landing this as
`needs_review` would hand TASK-265 a known-broken full suite. All code is
committed to `task/TASK-264-s5` (05f73fe) and ready to resume the instant
either Owned_Paths is widened or a follow-up task is filed for
`chat.routes.test.ts`.

## Work Log

- [2026-09-16T06:20:00Z] [S5] Read AGENTS.md, briefing, PLAN.md TASK-264/265, ADR-018 (incl. Amendment 2026-09-16) fresh from disk. Confirmed branch task/TASK-264-s5 already existed and was checked out (dispatcher-created); no dossier existed yet (first session). Ran preflight_paths.py (output above). Confirmed via full-repo grep that packages/templates and the templates install route do not exist anywhere in this codebase.
- [2026-09-16T06:35:00Z] [S5] Implemented services/control-api/src/defaultCapabilities.ts (DEFAULT_ROLE_CAPABILITIES + isDefaultRoleCapability), updated POST /roles in app.ts to grant that set instead of the sdk:builtin adapter filter (tier resolution unchanged, still live from deps.listCapabilities()). tsc --noEmit clean.
- [2026-09-16T06:50:00Z] [S5] Added services/control-api/src/app.test.ts: real-Postgres test (describe.skip without DATABASE_URL) proving AC1 (exactly the ten ids, each at live default tier) and AC2 (workspace.request_secret + one Gmail/Calendar/Drive id each confirmed absent despite being registered). Fixed an early bug in my own test (role response field is `id`, not `roleId` — confirmed via serializeRole in app.ts).
- [2026-09-16T07:10:00Z] [S5] Ran scripts/test-isolated.ps1 -Filter "@oikonomos/control-api". My new src/app.test.ts passes (1/1). Found src/chat.routes.test.ts's pre-existing TASK-117 test now fails because it still filters on adapter === "sdk:builtin" — a real, foreseeable break caused by this task's required change, in a file NOT in my Owned_Paths (Blocking finding 1). Also confirmed via full-repo search that AC3/AC4's referenced templates-install feature genuinely does not exist anywhere (Blocking finding 2). Committed all implemented code (05f73fe). Reporting blocked with both findings recorded above; recommendation on browser.interact (AC5) recorded above for TASK-265.

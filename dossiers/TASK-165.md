# TASK-165 — Expose bot title/instructions in the API and mobile settings UI

## Work Log

- [2026-09-05T15:06:48Z] [GB] Session start. `control.mode=strict`: PLAN.md not
  touched. Review_Findings empty (first pass, not rework). No prior dossier.
  Created `task/TASK-165-gb` from detached HEAD (`git checkout -b`). Preflight:

  ```text
  [preflight] TASK-165 Owned_Paths inspected in E:/DELL-PROJECTS/wt-grok-GROKBOT-CLONE
  [preflight] 3 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    FILE   services/control-api/src/app.ts  -> exists, 1142 line(s), 44314 bytes
    FILE   services/control-api/src/chat.routes.test.ts  -> exists, 1040 line(s), 53873 bytes
    GLOB   apps/mobile/**  -> 53 file(s):
             apps/mobile/README.md
             apps/mobile/analysis_options.yaml
             apps/mobile/android/app/build.gradle.kts
             apps/mobile/android/app/src/debug/AndroidManifest.xml
             apps/mobile/android/app/src/main/AndroidManifest.xml
             apps/mobile/android/app/src/main/kotlin/com/basileia/oikonomos_mobile/MainActivity.kt
             apps/mobile/android/app/src/main/res/drawable-v21/launch_background.xml
             apps/mobile/android/app/src/main/res/drawable/launch_background.xml
             apps/mobile/android/app/src/main/res/mipmap-hdpi/ic_launcher.png
             apps/mobile/android/app/src/main/res/mipmap-mdpi/ic_launcher.png
             apps/mobile/android/app/src/main/res/mipmap-xhdpi/ic_launcher.png
             apps/mobile/android/app/src/main/res/mipmap-xxhdpi/ic_launcher.png
             ... and 41 more
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```

  Approach: extend `serializeRole()` with `title` + `instructions` matching
  `packages/db/src/roles.ts` `Role` (`title: string`, `instructions: string | null`),
  honestly grow existing shape assertions, add a live-Postgres round-trip, then
  mobile Role parse + PATCH client + settings UI.

- [2026-09-05T15:18:00Z] [GB] Implementation complete.

  Backend (`services/control-api/src/app.ts`): `serializeRole()` now returns
  `{id, name, description, avatarSeed, title, instructions}` with
  `title: string | null` and `instructions: string | null`. Existing
  `toMatchObject` assertions in `chat.routes.test.ts` were grown (not
  loosened) to require those fields. Added empty-string PATCH coverage,
  404 coverage, and a live-Postgres GET/PATCH/clear round-trip.

  Mobile: `Role` parses `title` + `instructions`; `ApiClient` gained PATCH
  via `_request` and `updateRoleInstructions(roleId, instructions)` (empty
  string is the real clear contract). Settings screen shows the fetched
  title read-only ("No title set" only when null; helper still says no
  title-update endpoint) and an editable multi-line Instructions field
  with Save, Saving…, and a visible error on failure.

## Test Evidence

```
pnpm --filter @oikonomos/control-api test  (DATABASE_URL set, live Postgres)
→ 10 files, 151/151 passed (incl. chat.routes.test.ts 37/37: unit shape
  growth, empty-string PATCH, and live GET/PATCH serializeRole round-trip)

pnpm -r build → exit 0
pnpm lint → exit 0
pnpm -r test (DATABASE_URL set, parallel) → exit 0
  (two earlier parallel runs flaked on pre-existing evals/harness
  ome-two-role-handoff-live.test.ts TASK-141 racing worker kill-switch
  tests on the shared DB; isolated re-run 1/1; serial
  `pnpm -r --workspace-concurrency=1 test` exit 0; third parallel
  `pnpm -r test` exit 0 including evals 19/19 and control-api 151/151.)

apps/mobile:
  flutter analyze → No issues found! (24.4s)
  flutter test → 00:15 +82: All tests passed!
```

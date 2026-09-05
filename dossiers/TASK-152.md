# TASK-152 — APK → Gofile → Telegram release delivery script

## Work Log

- [2026-09-05T05:20:00Z] [S5] Session start (control.mode=strict). Read AGENTS.md, briefing,
  PLAN.md TASK-152 block fresh (no Review_Findings — first pass). No dossier existed yet.
  Stale `.devteam/CHECKPOINT.md` in worktree referenced TASK-149 (already merged/done) — not
  relevant to this task, left in place (not mine to delete per strict-mode file rules; harmless).
  Worktree HEAD was detached on an old TASK-149 commit; created `task/TASK-152-s5` fresh off
  `mainco/master` (081cc00, which already contains ORCH's TASK-152 claim commits).

  Preflight (`python scripts/preflight_paths.py TASK-152`):
  ```
  [preflight] TASK-152 Owned_Paths inspected in E:/DELL-PROJECTS/wt-s5-GROKBOT-CLONE
  [preflight] 3 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    GLOB   apps/mobile/tool/**  -> matches nothing yet (new territory)
    FILE   apps/mobile/pubspec.yaml  -> exists, 26 line(s), 578 bytes
    FILE   apps/mobile/.gitignore  -> exists, 32 line(s), 659 bytes
  ```

- [2026-09-05T05:40:00Z] [S5] Reviewed `apps/mobile/lib/api/api_client.dart` and
  `apps/mobile/test/support/fake_http_client.dart` for house conventions (injectable
  `http.Client`, `http.BaseClient` fake with a `requests` log). Confirmed `.gitignore`
  already covers `.env`/`.env.*` — no change needed there.

  Implemented `apps/mobile/tool/release_remote.dart`:
  - `ReleasePublisher` with injectable `http.Client`; three methods
    (`fetchUploadServer`, `uploadFile`, `sendTelegramMessage`) matching the spec's three
    calls exactly, each validating response shape and throwing `ReleaseCallError` with
    context on any HTTP/API-level failure.
  - `TelegramCredentials.fromEnvironment` — checks `TELEGRAM_BOT_TOKEN` then
    `TELEGRAM_CHAT_ID` independently, throwing `MissingEnvVarError` naming whichever is
    missing first, before any network call.
  - `requireExistingFile` — throws `MissingFileError` before any network call.
  - `buildReleaseMessage` — filename, size in MB, expiry note, download link, optional
    `--note`; no `git` shell-out.
  - `parseArgs` — `--note value` / `--note=value` plus a single positional file path,
    defaulting to `build/app/outputs/flutter-apk/app-release.apk`.
  - `main` wires it to `Platform.environment` + a real `http.Client`, catching the three
    error types and exiting 1 with a message on stderr (no stack-trace-only crash).

  Implemented `apps/mobile/tool/release_remote_test.dart` — 17 tests against
  `FakeHttpClient` (imported from `../test/support/fake_http_client.dart`, read-only
  reuse, not modified): missing-file / missing-env-var-each-independently guard tests
  (assert `fake.requests` stays empty), full three-call-flow-in-order test, Gofile
  `data.servers[0].name` selection test, multipart `file` field test, sendMessage body
  key-set test (`{chat_id, text}` only — `parse_mode` explicitly asserted absent),
  ok=false handling, `buildReleaseMessage` content tests, `parseArgs` tests. Sentinel
  token/chat-id assembled at runtime (`List.generate` + string interpolation), never a
  literal.

  Added `test: ^1.25.0` to `apps/mobile/pubspec.yaml` dev_dependencies (this script lives
  outside the widget-test tree and runs via `dart test`, which needs the standalone `test`
  package; `flutter_test` doesn't resolve outside the Flutter test runner). Ran
  `flutter pub get` locally to resolve it (cached, no network fetch needed — `test-1.31.1`
  was already in the local pub cache).

  Fixed one `flutter analyze` info (`prefer_interpolation_to_compose_strings` in the test
  file's sentinel-token builder) and one test assertion that read a header not present on
  an unfinalized `MultipartRequest` (switched to asserting on `multipart.files` directly).

  **Test evidence:**
  - `dart tool/release_remote.dart` unit tests: `dart test tool/release_remote_test.dart`
    → `+17: All tests passed!` (0 real network calls; `FakeHttpClient.requests` used to
    assert per-test call counts, including the empty-list assertion for both
    before-any-HTTP-call error paths).
  - `flutter analyze` → `No issues found! (ran in 4.6s)`, exit 0.
  - `flutter test` (full existing widget/unit suite) → `+59: All tests passed!` — TASK-152
    changes do not regress Wave 1/2 mobile work.

  **Territory note:** `flutter pub get` regenerated `apps/mobile/pubspec.lock`, which is
  git-tracked but **not** listed in this task's `Owned_Paths`
  (`apps/mobile/tool/**, apps/mobile/pubspec.yaml, apps/mobile/.gitignore`). The
  territory-precommit hook correctly rejected staging it. Committed `pubspec.yaml`'s
  `test` dependency addition without the regenerated lockfile — a fresh `flutter pub get`
  in `apps/mobile` will regenerate it locally/in CI (the constraint is satisfiable from
  the same cache used here, `test-1.31.1`/`1.31.0`). Flagging for ORCH in case
  `pubspec.lock` needs adding to this task's `Owned_Paths` retroactively, or ORCH prefers
  to regenerate and commit it directly during review.

  Commit: `a4cbe38 feat(mobile): APK release delivery via Gofile + Telegram [TASK-152]`
  on `task/TASK-152-s5` — 3 files changed (`release_remote.dart`, `release_remote_test.dart`,
  `pubspec.yaml`), 561 insertions.

  All acceptance criteria met:
  - [x] Three-call flow in spec order, exact request/response shapes, tested against a
        fake HTTP client — no real network call anywhere in the suite.
  - [x] `sendMessage`'s JSON body never includes `parse_mode` — tested via explicit
        key-set assertion (`{chat_id, text}`).
  - [x] Missing `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` produce a clear, immediate,
        named error before any HTTP call — tested independently for each.
  - [x] Missing target file produces a clear error before any HTTP call — tested.
  - [x] No literal bot token/chat-id/credential-shaped literal in source or fixtures —
        reviewed directly (`grep` for token/chat-id-shaped patterns: no matches); sentinel
        values assembled at runtime.
  - [x] `flutter analyze` and `flutter test` exit 0; only files inside `Owned_Paths`
        touched (`pubspec.lock` explicitly excluded per territory firewall, noted above).

  Status → `needs_review`.

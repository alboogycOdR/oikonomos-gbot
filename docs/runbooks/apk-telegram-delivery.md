# Runbook — APK → Gofile → Telegram release delivery

**Status:** live, tested (TASK-152). **Owner:** ORCH (this doc is a protected path, `docs/**` — builders cannot edit it). **Script:** `apps/mobile/tool/release_remote.dart`.

## What this is

A three-call flow that gets a built Flutter APK into your hands without setting up a CI artifact store or a real release channel:

1. `GET https://api.gofile.io/servers` — pick the first server name, no auth.
2. `POST https://<server>.gofile.io/contents/uploadfile` — multipart upload the APK, no auth, ~10-day expiry, no size cap.
3. `POST https://api.telegram.org/bot<TOKEN>/sendMessage` — post the resulting download link as a **plain-text** message to a Telegram chat.

This is a **temporary handoff mechanism, not a release channel.** The Gofile link expires in about 10 days. For anything long-lived, use Firebase App Distribution, TestFlight, or a Play internal track instead.

## One-time setup

1. **Create a Telegram bot.** Message `@BotFather` → `/newbot` → save the token it gives you (`1234567890:AAA...`).
2. **Get your chat ID.** Message `@userinfobot` — it replies with a numeric ID.
3. **Message your own bot once, first.** Until you initiate, the bot cannot DM you.
4. **Set the two environment variables** wherever you run the script (never in a committed file):
   ```
   TELEGRAM_BOT_TOKEN=<your bot token>
   TELEGRAM_CHAT_ID=<your chat id>
   ```

**The bot token is a credential.** If it's ever exposed (pasted somewhere, committed by accident, shared in a doc), revoke it immediately via `@BotFather` → `/revoke` and generate a fresh one.

## Running it

```bash
cd apps/mobile
flutter build apk --release
dart run tool/release_remote.dart
```

With no argument, it defaults to `build/app/outputs/flutter-apk/app-release.apk`. Pass a different path for any other file:

```bash
dart run tool/release_remote.dart path/to/some-file.apk
```

Add an optional note to the Telegram message (the script deliberately does **not** shell out to `git` for a commit message — see "Design notes" below):

```bash
dart run tool/release_remote.dart --note "Fixes the login crash"
# or
dart run tool/release_remote.dart build/app/outputs/flutter-apk/app-release.apk --note="v0.3 candidate"
```

On success it prints `Release published: <path>` and the Telegram message lands in your chat with the download link, file size, and expiry note.

## Failure modes

- **Missing `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID`** — fails immediately with a named error before any network call. Set the missing variable and re-run.
- **File not found** — fails immediately, before any network call, naming the path it looked for.
- **Gofile or Telegram API error** — the script surfaces the HTTP status; nothing partially succeeds silently (if the upload fails, no Telegram message is sent).

## Design notes (why it deviates from the original spec)

- **Dart, not Node.js.** The mobile app is already Flutter/Dart; this avoids a second toolchain for one script.
- **Lives in `apps/mobile/tool/`, not root `scripts/`.** Root `scripts/` is DEVDEPARTMENT's own orchestration machinery; this is product release tooling and belongs with the app it ships.
- **No `parse_mode` on the Telegram message, ever.** Telegram's legacy Markdown parser aborts the entire send on any unmatched `_`/`*`/backtick in a message (e.g. from a commit message), and MarkdownV2 requires escaping ~15 characters. Plain text is reliable, and Telegram auto-links URLs regardless. This is enforced by a test that inspects the actual sent JSON body's key set, not just a happy-path check.
- **No `git` shell-out for a commit hash/message.** The original spec's reference script ran `git rev-parse`/`git log` from inside the release script. That's an implicit dependency on the invoking shell's working directory and git state — it quietly breaks the moment this runs from CI or a different directory. An optional `--note` argument replaces it; if you want a commit reference in the message, pass it explicitly (e.g. from your own build script, where the git context is already known).

## Reference

- `apps/mobile/tool/release_remote.dart` — the implementation
- `apps/mobile/tool/release_remote_test.dart` — tests against a fake HTTP client, including the `parse_mode`-absence and missing-env-var proofs
- PLAN.md TASK-152 — full review record

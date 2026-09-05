# Runbook — Firebase Android setup for the mobile client

**Status:** live, verified with a real `flutter build apk --debug` (2026-09-05). **Owner:** ORCH (this doc is a protected path, `docs/**`).

## What's already done

- Firebase is attached to the existing GCP project `basileia-oikonomos-gmail` (project number `461377597606`) — attached to the existing project rather than creating a new one, to avoid a project-creation quota limit.
- An Android app is registered in that Firebase project: package name **`com.basileia.oikonomos`**, App ID `1:461377597606:android:135bb083516c416e788467`.
- `apps/mobile/android/` is scaffolded and committed (it was deliberately deferred at TASK-144). `applicationId` in `android/app/build.gradle.kts` is set to `com.basileia.oikonomos` to match the registered app exactly — **these two must never drift apart**, or Firebase refuses to initialize.
- The `com.google.gms.google-services` Gradle plugin is wired into `android/settings.gradle.kts` and `android/app/build.gradle.kts`.

## What every machine building this app needs to do once

**`google-services.json` is gitignored, not committed.** The repo's commit-time secret scanner blocks it as a Google-API-key pattern, with no allowlist mechanism for keys that are safe-by-design (this one is restricted by package name + SHA fingerprint, not secrecy — but the scanner can't tell the difference, and the call was made to keep the file local rather than add a scanner exception). So:

1. Get a copy of `google-services.json` for the `com.basileia.oikonomos` app. Either:
   - Firebase Console → Project settings → your Android app → download `google-services.json`, or
   - `firebase apps:sdkconfig ANDROID 1:461377597606:android:135bb083516c416e788467 --project basileia-oikonomos-gmail --out google-services.json` (needs `firebase login` first).
2. Place it at `apps/mobile/android/app/google-services.json`. It's gitignored — this step is real and manual on every machine.
3. Confirm `"package_name": "com.basileia.oikonomos"` inside it matches `applicationId` in `android/app/build.gradle.kts`. If either one is ever changed, change both together.

## A known build issue you may hit (and its fix)

Building `firebase_core` on Windows can fail with:
```
Execution failed for task ':firebase_core:compileDebugKotlin'.
> ... Could not close incremental caches in .../compileDebugKotlin/cacheable/caches-jvm/...
```
This is a Kotlin Build-Tools-API incremental-compilation bug (a file-handle-closing race in the compiler's memory-mapped cache storage) — nothing to do with the app or the Firebase config. It's already worked around: `android/gradle.properties` sets `kotlin.incremental=false`. If you see this error anyway (e.g. a stale cache from before that property existed), run `flutter clean` and rebuild.

## Verifying it actually works

```bash
cd apps/mobile
flutter analyze          # should be clean
flutter test              # 59/59 as of this writing
flutter build apk --debug # proves the config file + plugin wiring genuinely work, not just that they parse
```

A successful `flutter build apk` with the config file in place is real proof — `flutter analyze`/`flutter test` alone cannot catch a mismatched `applicationId` or a missing plugin, since neither touches the Gradle/Kotlin build pipeline that actually reads `google-services.json`.

## Reference

- `apps/mobile/android/app/build.gradle.kts` — `applicationId`, plugin application
- `apps/mobile/android/settings.gradle.kts` — plugin version declaration
- `apps/mobile/android/gradle.properties` — the `kotlin.incremental=false` workaround
- `docs/runbooks/apk-telegram-delivery.md` — how to ship the built APK once you have one
- `apps/mobile/lib/main.dart` — `_resolvePushPort()`: `Firebase.initializeApp()` failing (no config file present) is the intentional fallback gate to `NoopPushPort`, not an error

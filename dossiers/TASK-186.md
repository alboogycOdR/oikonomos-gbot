# TASK-186 — G-06 — Browser lane v1: Steel Browser inside the role sandbox, bot-private profile, governed `browser.*` capability family (protected paths)

## Brief

Nothing in the product can click a website today. Build the image `office-browser` (Playwright/Chromium + Steel Browser, Xvfb screen, execd-compatible entrypoint) and a manifest `steel-browser.json` declaring the `browser.*` tools (navigate/read/click/type/screenshot) with default tiers per ADR-010's tier map (read-only T0/T1; writes T2; anything on a payment/login page escalates to human takeover). Profile directory is per role (`bot_private` — deliberately stricter than Grok Bot's user-shared profile) and lives under the D3 sealed root so the secretPathGuard (TASK-088/093) denies any `/command` or file-tool access to it. Steel's stealth/anti-detection features are OFF; a CAPTCHA/2FA/login-wall detection emits `human_takeover_required` (consumed by TASK-188) and never attempts a solve. The Steel session URL is what TASK-171's live view embeds. Application-layer egress allowlist in Steel session config stays as defence in depth beneath TASK-185's network layer (R15).

## Spec pointers

specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md §3 G-06 (AC anchors: profile cookies unreadable from a /command run — observed denial; CAPTCHA raises human_takeover_required, no solve attempt); ADR-006 Addendum B (Steel inside OpenSandbox; OIK-076/077 narrowing); ADR-010 Amendment + Addendum F N13 (browser credentials inaccessible by construction); CLAUDE.md NN#6 (stealth off, no circumvention); report §12.5(d), §12.7; ADR-013 (manifest declares tiers). PROTECTED PATHS packages/connectors/manifests/**, packages/harness-factory/** — author CX, reviewer ORCH opus-4-8.

## Territory

packages/connectors/manifests/steel-browser.json, infra/sandbox/images/office-browser/**, packages/harness-factory/src/browserLane.ts, packages/harness-factory/src/browserLane.test.ts, packages/connectors/src/steelSession.ts, packages/connectors/src/steelSession.test.ts

Depends_On: TASK-170, TASK-185

## Intended approach

Read the Spec pointers first, then the existing files named in Territory (run the preflight and paste it into the first Progress_Note). Match surrounding conventions exactly — packages/db follows routines.ts; control-api routes follow the chat routes + openapi.ts; mobile follows the TASK-157/168 visual bar. Every acceptance criterion maps to a spec sentence; test the criterion, not the summary. Anything outside Territory is a block, not an edit.

## Work Log

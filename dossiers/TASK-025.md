# TASK-025 dossier

## Work Log

- [2026-08-16T03:29:00Z] [CX] Preflight completed: `infra/ci/**` exists (14 files). Began implementation of a builder-worktree hook probe so the main checkout can observe a real territory rejection without treating ORCH's intended allow as proof of liveness.
- [2026-08-16T03:23:15Z] [CX] Chose the registered-builder-worktree mechanism. `controls-live` resolves the main checkout, enumerates registered builder worktrees from `autopilot.json` plus `git worktree list`, and probes one there. It fails loudly as UNOBSERVABLE if none exists. Verified: `node infra/ci/test-controls-live.mjs` (7/7 pass, including temporary exact `#!/bin/sh` + `exit 0` injection and restoration); all three other `infra/ci` self-test suites pass; and from `C:\CLAUDECODE_TOOLSETS\oikonomos`, `node ..\wt-codex-oikonomos\infra\ci\run-local.mjs --approval-marker fable-reviewed` exits 0 with every job PASS.

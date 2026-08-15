# TASK-018 — OIK-003 CODEOWNERS + protected-path CI enforcement ⚑ protected

**Brief:** Make the protected-path rule mechanical instead of convention-plus-review. CODEOWNERS covering the protected paths, plus a local check that fails a diff touching them without the required review.

**Spec pointers:** WBS OIK-003. Handover §3 and CLAUDE.md for the authoritative protected-path list. TASK-004 set the no-remote precedent: demonstrate acceptance via a locally runnable script.

**Intended approach:** Be honest about the limit — CODEOWNERS is inert without a GitHub remote, so the local script is the operative control until one exists, and the README must say so rather than implying coverage that is not there. Self-test both directions.

## Work Log

- [2026-08-15T14:20:00Z] [CX] Preflight completed: `.github/CODEOWNERS` is NEW; `.github/workflows/**` contains `ci.yml`; `infra/ci/**` contains the 10 existing CI artifacts. Read CLAUDE.md, directive §3, WBS OIK-003, Handover §3, and the existing local CI scripts. Beginning implementation on task branch `task/TASK-018-cx`.
- [2026-08-15T14:49:00Z] [CX] Implemented CODEOWNERS and the local/CI protected-path gate. `node infra/ci/run-local.mjs` passed: typecheck, build, workspace tests, lint, banned-mode tests/scan, secret-scan tests/scan, and protected-path review self-test all green.

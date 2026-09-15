# TASK-260 Dossier

## Work Log

- [2026-09-15T10:30:00Z] [CX9] Resumed dispatcher claim on `task/TASK-260-cx9`. Reviewed task contract and no rework findings. Audited `api.ts`: the four stated bodyless calls are `logout`, `pauseRoutine`, `resumeRoutine`, and `testRunRoutine`; all now omit the default JSON content type through the shared helper. Mobile audit: `apps/mobile` has no `/auth/logout` HTTP call and only clears its own locally managed session cookie plus Firebase/Google state, so it does not share this defect.
- [2026-09-15T10:35:00Z] [CX9] Verification passed: `pnpm --filter @oikonomos/dashboard typecheck`; `pnpm --filter @oikonomos/dashboard test` (21 files, 129 tests); and `powershell -ExecutionPolicy Bypass -File scripts\\test-isolated.ps1` (full workspace isolated suite). The helper now builds headers with `Headers`, adds JSON content type only for non-null/defined bodies, and preserves explicit caller headers.

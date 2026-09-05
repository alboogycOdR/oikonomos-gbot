# TASK-172 dossier

## Work Log

- [2026-09-05T20:00:00Z] [CX] Started from the dispatcher-claimed branch. Preflight evidence:
  ```text
  [preflight] TASK-172 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex-GROKBOT-CLONE
  [preflight] 6 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    FILE   services/control-api/src/app.ts  -> exists, 1330 line(s), 50843 bytes
    FILE   services/control-api/src/auth.ts  -> exists, 157 line(s), 6034 bytes
    FILE   services/control-api/src/auth.test.ts  -> exists, 136 line(s), 4796 bytes
    FILE   services/control-api/src/ports.ts  -> exists, 440 line(s), 18530 bytes
    FILE   services/control-api/package.json  -> exists, 39 line(s), 888 bytes
    FILE   pnpm-lock.yaml  -> exists, 5111 line(s), 170140 bytes
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```
- [2026-09-05T20:00:00Z] [CX] Firebase official verification guidance supports a lightweight `jose` JWKS verifier: RS256 signature, Google rotating keys, issuer, audience, expiry/issued-at and non-empty UID subject validation. Implemented UID-scoped session claims, `POST /auth/google`, authenticated request tenant decoration, and all eight former hardcoded tenant call sites. Existing fixture roles under `basileia` are intentionally service/test tenant data and are not migrated to a real user.
- [2026-09-05T20:14:00Z] [CX] Verification complete: `pnpm --filter @oikonomos/control-api test -- auth.test.ts` passed 29/29 including the real-Postgres two-user isolation case; package suite passed 161/161; repository-wide `pnpm -r test`, `pnpm -r build`, and `pnpm lint` completed successfully. `git diff --check` is clean.
- [2026-09-05T22:25:00Z] [CX] REWORK addressed: the real-Postgres Firebase UID isolation test now tracks its two created role IDs and, in `finally`, closes the app then deletes their dependent `role_grants` and the roles before closing its dedicated pool. Targeted `auth.test.ts` passed 29/29; `pnpm -r build` and `pnpm lint` passed. `pnpm -r test` reached one unrelated pre-existing `packages/db` inbox-triage capability enabled-state drift failure (152 passed, 1 failed, 2 skipped); TASK-172's test passed within that run.
- [2026-09-05T22:27:00Z] [CX] Live cleanup proof: immediately after the targeted integration test, a direct read-only Postgres query reported `0` rows for tenants `firebase-integration-a` and `firebase-integration-b`.

# TASK-099 Dossier

## Work Log

- [2026-09-02T14:34:00Z] [CX] Resumed `task/TASK-099-cx`. Read `AGENTS.md`, `briefings/CODEX_BRIEFING.md`, the TASK-099 PLAN block, OIK-102, and ADR-012 §2.4–2.5. Preflight output: `services/workspace/src/mailbox.ts` exists (274 lines); `services/workspace/src/mailbox.test.ts` is NEW; `services/workspace/src/index.ts` exists (25 lines). Blocked before edits: TASK-099 needs typed `handoffKind`/`factRef` persisted in `role_messages`, but `@oikonomos/db` currently exposes only `workspaceRefs` and its INSERT targets only `(tenant_id, from_role_id, to_role_id, body, workspace_refs)`. Required changes are outside owned paths: `packages/db/src/roleMessages.ts` plus the repository's database schema/migration location. Encoding the fact reference as a workspace reference would violate the existing schema contract and the acceptance criterion that the persisted row carry a fact reference.

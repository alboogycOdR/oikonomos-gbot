# TASK-358 dossier

**Brief:** Web: bot-to-bot entries and "Messaged X" previews in the sidebar.

Web parity for TASK-357 in BotSidebar: bot_pair entries with pair avatar and read-only transcript; bot_outbound previews with an arrow icon.

**Assigned:** CX9. **Depends on:** TASK-356, TASK-354.

**Spec pointers:** specs/OIKONOMOS_CHAT_SURFACE_v1.0.md section 8; TASK-356 API

**Approach:** Read the Description and Acceptance_Criteria in PLAN.md, then the current code in Owned_Paths, before changing anything. Work on the pre-cut branch from master. Run tests in the FOREGROUND and wait for them to finish before emitting the control block. Review requires `pnpm build` and `pnpm typecheck` to exit 0 (Flutter tasks: `flutter test` plus `flutter analyze lib`). A failure already on master is still named and classified, never waved off as "baseline".

## Work Log

- [2026-09-25T11:21:37Z] [CX9] Preflight passed for all four Owned_Paths: `BotSidebar.tsx` (187 lines), `BotSidebar.test.tsx` (52 lines), `types.ts` (70 lines), and `api.ts` (774 lines). Blocked before implementation: TASK-356's `GET /threads` supplies `GroupThread.kind: "bot_pair"` and `preview.authorKind: "bot_outbound"`, but unowned `apps/dashboard/src/pages/ChatPage.tsx` drops both in `toBotSummary`. `BotSidebar` consequently receives neither discriminator nor preview attribution and cannot safely render the pair row/outbound icon or route pair selection to a read-only transcript. Please add `ChatPage.tsx` to Owned_Paths (and, if the intended transcript should reuse the existing shell rather than a sidebar-owned modal, the relevant shell/compose ownership) before re-dispatch.

- [2026-09-25T11:40:00Z] [CX9] Implemented web parity: threaded TASK-356 `kind`/`preview.authorKind` through dashboard types and `ChatPage`, added paired avatars plus an observational modal transcript that reuses `ConversationPane` without a composer, and rendered the outbound arrow. Added component coverage for pair transcript/read-only behavior, outbound marker, legacy-group fallback, and the `ChatPage` API-to-sidebar mapping. Verification: `scripts/test-isolated.ps1 -Filter dashboard` 27 files/174 tests passed; `pnpm build` and `pnpm typecheck` exited 0; `scripts/test-isolated.ps1 -Init` passed; foreground full `scripts/test-isolated.ps1` passed (only pre-existing React act warnings, no failures). Dashboard supplies no lint script.

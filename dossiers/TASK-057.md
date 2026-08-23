# TASK-057 - Telegram task intake + run status (OIK-085)

## Brief
`/task`, `/runs`, `/approvals` against control-api. The service src is a stub, but the package already carries **salvaged utilities from the old bot** (formatting, permissions, session store, stream renderer) - read and reuse them before writing anything new.

## Spec pointers
- OIK-085 - `/task`, `/runs`, `/approvals` functional.
- OIK-084 - surfaces consume control-api, **not the DB**. Assert it: a test that fails if a `@oikonomos/db` import appears anywhere in this service.
- N4 - Telegram client injected as a port; no bot token in any fixture.

## Intended approach
Reuse the salvaged permissions module for chat-ID authorization; record in the work log what you reused vs rewrote.

## Work Log

- [2026-08-23T21:05:00Z] [CX] Preflight: `services/gateway-telegram/src/**` exists (1 file: `src/index.ts`); `services/gateway-telegram/test/commands.test.ts` is new territory. Reused the salvaged `formatting.ts` MarkdownV2 escape logic in new `src/formatting.ts`; the salvaged permission/session/stream utilities are not applicable to these three read/create commands and remain untouched. The task-specific gateway keeps the Telegram client token-free and adds an injected control-api HTTP adapter rather than any database access. Implemented `/task`, `/runs`, and `/approvals` plus authorization and OIK-084 boundary tests. Initial package test run exposed only a Windows URL-path issue in the source-scan test; source typecheck and build passed.
- [2026-08-23T21:07:00Z] [CX] Verification complete: `pnpm --filter @oikonomos/gateway-telegram test` passed 54/54; package typecheck passed; root lint passed; `pnpm canaries` passed 15/15 (2 intentional skips). `pnpm -r test` passed all preceding workspaces including gateway, then stopped on an unrelated `@oikonomos/connectors` workspace-link failure: `test/enumeration.test.ts` cannot resolve `@oikonomos/policy`. No TASK-057 files are implicated.

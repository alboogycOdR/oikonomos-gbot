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

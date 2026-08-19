# TASK-056 - services/control-api (OIK-084)

## Brief
Currently a 13-line stub. Build the Fastify service every surface consumes - `POST /tasks`, `GET /runs`, `GET /runs/:id`, `GET /approvals`, `POST /approvals/:nonce/decide`, `GET /runs/:id/evidence`, plus a published OpenAPI document.

## Spec pointers
- OIK-084 - "OpenAPI spec published; **all surfaces consume this, not the DB**". That sentence is why the Telegram lane may not import `@oikonomos/db`.
- N8 - approvals are nonce-bound, single-use, one atomic SQL consume. That logic lives in `packages/approvals`; this service **delegates**, never reimplements.
- N4 - redact approval route bodies in logs; no nonce in emitted logs.

## Intended approach
All persistence via `@oikonomos/db` / `@oikonomos/approvals` public APIs - no raw SQL here. Fastify goes in **your** package.json only; never the root or lockfile beyond what pnpm writes for your package. DB-gated integration legs must actually RUN locally (a skipping DB test is not evidence - TASK-035/044 precedent; ORCH re-runs live at review). Mutation: a local reimplementation of the nonce check must turn a test red.

## Work Log

# TASK-083 — Headless OAuth token acquisition for the Gmail MCP server

## Brief
Build `oauthTokenProvider.ts`: exchange a long-lived refresh token for short-lived access tokens via Google's OAuth 2.0 token endpoint (`grant_type=refresh_token`), cache until near-expiry, wire `Authorization: Bearer` into `httpListTools.ts` when a provider is configured. N4: never log/print/write client secrets or tokens.

## Spec pointers
- docs/runbooks/gmail-mcp-provisioning.md §3 (headless token presentation)
- WBS OIK-049
- Directive §4 N4 (no credentials in logs/prompts/fixtures)

## Work Log

- [2026-09-01T10:20:20Z] [GB] Session start on newly claimed branch `task/TASK-083-gb` (created from detached HEAD 39982d1). control.mode=strict: no PLAN.md writes. Preflight (c8b9872 filesystem check):
  ```
  [preflight] TASK-083 Owned_Paths inspected in E:/DELL-PROJECTS/wt-grok-GROKBOT-CLONE
  [preflight] 5 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    NEW    packages/connectors/src/mcp/oauthTokenProvider.ts  -> does not exist; parent packages/connectors/src/mcp/ exists
    NEW    packages/connectors/src/mcp/oauthTokenProvider.test.ts  -> does not exist; parent packages/connectors/src/mcp/ exists
    FILE   packages/connectors/src/mcp/index.ts  -> exists, 13 line(s), 441 bytes
    FILE   packages/connectors/src/enumeration/httpListTools.ts  -> exists, 310 line(s), 8990 bytes
    FILE   packages/connectors/test/enumeration.test.ts  -> exists, 468 line(s), 16173 bytes
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```
  NEW files are expected (no OAuth code in the repo yet). `OIK_SECRET_GMAIL_OAUTH_CLIENT_ID`/`_SECRET` and `OIK_SECRET_MCP_GMAIL_URL` are present; `OIK_SECRET_GMAIL_OAUTH_REFRESH_TOKEN` is unset. Implementing token-exchange + cache + httpListTools Bearer wiring against a local fake OAuth endpoint. Live authenticated re-enumeration will BLOCK with MISSING_DEPENDENCY if the refresh token is still unprovisioned at the live-wiring step (task Description, explicit non-goal).

- [2026-09-01T10:26:10Z] [GB] Implementation complete on `task/TASK-083-gb`. Token-exchange + cache + Bearer wiring landed; live authenticated re-enumeration blocked on missing refresh token (see below).

  **Code**
  - `packages/connectors/src/mcp/oauthTokenProvider.ts` — `createOAuthTokenProvider` POSTs `grant_type=refresh_token` + client_id/secret/refresh_token as `application/x-www-form-urlencoded` to an injected token endpoint (default: Google token host assembled at runtime so the module holds no URL literal). In-memory cache until `now + skew < expiresAt` (default skew 60s); injected `now`. Concurrent cold-cache calls coalesce. Failures throw `OAuthTokenError` (`TOKEN_EXCHANGE_FAILED` / `NETWORK_ERROR` / `INVALID_RESPONSE` / `SECRET_UNSET` / `SECRET_EMPTY`); messages name a REF or OAuth error code, never a token. `createGmailOAuthTokenProvider` resolves `secret://gmail/oauth/client/id|secret` and `secret://gmail/oauth/refresh/token` via `envSecretResolver` (`OIK_SECRET_GMAIL_OAUTH_*`).
  - `packages/connectors/src/enumeration/httpListTools.ts` — optional `tokenProvider` on `HttpMcpEnumeratorOptions`. When set, `Authorization: Bearer <token>` is attached to every RPC; empty token fails closed. When unset, headers are unchanged (no Authorization). Token-provider throws propagate; MCP is not contacted (no unauthenticated fallback).
  - Barrel: `packages/connectors/src/mcp/index.ts` re-exports the provider. `packages/connectors/src/index.ts` is outside Owned_Paths — package-root re-export needs ORCH merge wiring (same as TASK-053).

  **Tests** (local fake HTTP OAuth endpoint, not the real Google one)
  - `oauthTokenProvider.test.ts` (12): exchange shape; default Google host; cache + injected clock (reuse then near-expiry refresh); in-flight coalesce; invalid_grant / network / missing access_token typed errors; empty constructor; Gmail factory + SECRET_UNSET names the REF; envSecretResolver mapping; N4 source+serialization opacity (assembled sentinels, no `ya29.`).
  - `enumeration.test.ts` (+4 run, +2 skipIf): Bearer attached when provider configured; no Authorization when none; typed error + zero MCP hits on token failure (and enumerateTools report.ok=false, mapped=[]); N4 bearer not in enumerator errors. Live authenticated pair skipIf-gated on `OIK_SECRET_GMAIL_OAUTH_REFRESH_TOKEN`.

  **Test_Evidence**
  - `pnpm --filter @oikonomos/connectors test` — 9 files, 84 passed | 2 skipped (the two live-authenticated tests; unauthenticated live `tools/list` still ran and passed).
  - `pnpm --filter @oikonomos/connectors typecheck` — exit 0.
  - `pnpm lint` — exit 0.
  - `pnpm canaries` — 15 passed | 2 skipped (17).
  - `pnpm -r test` — exit 0.

  **Live half — BLOCKING**
  `OIK_SECRET_GMAIL_OAUTH_REFRESH_TOKEN` is unset in process env and `~/.oikonomos/gmail.env` (keys present there: CLIENT_ID, CLIENT_SECRET, MCP_GMAIL_URL only). Task Description explicit non-goal: minting the initial refresh token is an operator/ORCH browser consent, not this task; do not skip or fake the live re-enumeration. Per that rule: `MISSING_DEPENDENCY: refresh token not provisioned`.

  **Next step for ORCH / operator:** one-time interactive OAuth consent (runbook §3), store the refresh token as `OIK_SECRET_GMAIL_OAUTH_REFRESH_TOKEN` (env + gmail.env). Re-dispatch GB on this same branch; the skipIf live tests will then run and record whether `send_message`/`reply`/`forward` appear on the authenticated surface (expected: yes; send_message mapped+disabled, reply/forward unmapped, all denied from the allowlist).

  Stopping point: all fake-endpoint + wiring work committed; waiting on the refresh token. No further code needed unless live results require it.

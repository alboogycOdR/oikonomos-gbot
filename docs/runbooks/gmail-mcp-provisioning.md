# Runbook: Gmail MCP provisioning (unblocks TASK-054/055, feeds TASK-060)

**Owner of the clicks:** Alister. **Time:** ~15 min. **Written:** 2026-08-26 (ORCH).

## Decision: use Google's official hosted Gmail MCP server

Endpoint: `https://gmailmcp.googleapis.com/mcp/v1` (HTTP transport — matches the manifest's `transport: remote`).

Why this over a self-hosted or community server:

1. **Scope-perfect.** It requests exactly `gmail.readonly` + `gmail.compose` — the two scopes `docs/connectors/gmail.md` §2 mandates. Nothing to configure down.
2. **Draft-only by construction.** Its tool list contains **no send tool whatsoever** (`create_draft`, `list_drafts`, `get_thread`, `get_message`, `search_threads`, label tools). The G-CONN property "send is impossible" is enforced by Google's server surface itself, on top of the missing `gmail.send` scope — two independent layers before our own tier map even engages.
3. **Zero hosting.** Nothing to run, patch, or supply-chain-audit on our side.
4. What we do NOT use: Gmail **app passwords** (IMAP/SMTP basic auth — wrong protocol, and grants full mailbox incl. send, defeating the scope control) and community servers requesting `gmail.modify`/`gmail.send` (violates §2's no-scope-without-consuming-capability rule).

**Fallback** (only if the hosted server's auth proves unusable headless — see §4): self-hosted `google_workspace_mcp` (taylorwilsdon), streamable-HTTP, per-service scope flags (`gmail` limited to readonly+compose), single-user mode, loopback-bound. Requires its own pin + review before use; do not reach for it without an ORCH decision.

## 1. Google Cloud setup (Alister, one-time)

1. https://console.cloud.google.com → **New project** → name `basileia-oikonomos-gmail` (any Basileia-owned org/account — N5: `account_ownership: basileia`; never a client or employer account).
2. **APIs & Services → Library** → enable **Gmail API** (and the Gmail MCP enablement if the console lists it separately per Google's MCP guide).
3. **OAuth consent screen** → Internal if the account is in a Workspace org; otherwise External + **Testing** mode with the Basileia Gmail address as the only test user. Add scopes `.../auth/gmail.readonly` and `.../auth/gmail.compose` — **nothing else, explicitly not `gmail.send`** (Wave-1 rule, gmail.md §2).
4. **Credentials → Create credentials → OAuth client ID → Web application** (the hosted MCP server uses the web flow, not Desktop). Redirect URI: the one for the MCP client that will perform the consent (for a Claude-harness consent: `https://claude.ai/api/mcp/auth_callback`; per Google's configure-mcp-server guide).
5. Copy the **Client ID** and **Client secret** into the local secret store / env only. **Never into the repo, a fixture, a prompt, or this chat** (non-negotiable #4). Suggested env names: `OIK_SECRET_GMAIL_OAUTH_CLIENT_ID`, `OIK_SECRET_GMAIL_OAUTH_CLIENT_SECRET`.

## 2. Wire it to OIKONOMOS

The manifest resolves `secret://mcp/gmail/url` → env (`packages/connectors/src/mcp/envSecretResolver.ts`):

```
OIK_SECRET_MCP_GMAIL_URL=https://gmailmcp.googleapis.com/mcp/v1
```

Set it in the environment the worker/dispatch inherits (e.g. the local `.env` consumed by the compose/dev shell — same place the DB URL lives; never committed).

## 3. Consent + token (first run)

The hosted server speaks the MCP OAuth 2.1 flow: the MCP client initiates auth, Alister approves in the browser once against the Basileia account, and the client holds/refreshes the token. Verify during the TASK-054 unblock:

- Interactive proof first: mount the server in a throwaway Claude Code session (`/mcp` auth flow) and run `tools/list` — this is the OIK-049 live-enumeration evidence.
- Headless: confirm the Claude Agent SDK http-MCP mount can present the token non-interactively (token handed via the TASK-053 `headers` secret-ref mechanism if needed). **If headless token presentation is not achievable, that is the trigger for the §Fallback decision — do not fake it** (TASK-054's own rule).

## 4. Known reconciliation, decided at TASK-054 review (ORCH)

The manifest's tool map (`packages/connectors/manifests/gmail.yaml`) predates the live server and names `mcp__gmail__list_messages` / `mcp__gmail__send_message`. The live server exposes `search_threads`/`get_message`/etc. and **no send tool**. At 054's live-enumeration review:

- Re-map `email.list` (T0) to the real read tools (`search_threads`, `get_message`, `get_thread`, `list_drafts`, `list_labels`); `create_draft` already matches (T1).
- Label tools (`label_thread`, `create_label`, …) are WRITE operations — map them explicitly (T1 at most) or leave unmapped ⇒ denied by default (Handover §4.2). Do not let them ride in unmapped-but-mounted.
- Keep the `email.send / enabled: false / T3` row: it documents the tier ceiling even though no live tool backs it (defence-in-depth pairing, gmail.md §2).
- The manifest edit is an onboarding change → ORCH-reviewed per the gmail.md precedent, and the enumeration re-run must then show **zero unmapped live tools**.

## 5. Reversal

Revoke at https://myaccount.google.com/permissions (Basileia account) → the token dies; delete the OAuth client in the console; unset `OIK_SECRET_MCP_GMAIL_URL`. Capability kill switch (`capabilities.enabled=false`) remains the runtime deny (gmail.md §6).

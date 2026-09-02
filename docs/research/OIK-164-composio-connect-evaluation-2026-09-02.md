# OIK-164 — Composio Connect evaluation spike

**Date:** 2026-09-02 · **Author:** CX (TASK-051) · **Status:** Recommendation only — adoption requires an ADR (Addendum D §2 OIK-164)

## Brief

Can Composio Connect supply connectors for G1 without violating the N5 scope boundary? Required to address explicitly: (1) hosted third-party gateway vs. N5/data sovereignty (R19); (2) per-tool tier-mapping feasibility against the OIK-047 manifest schema; (3) cost vs. the R30,000/month ceiling.

## Recommendation — do not adopt Composio Connect for G1

**Decision:** Do **not** adopt Composio Connect as the G1 connector supply path. It is a useful market/reference signal and may merit a later, separately scoped ADR evaluation, but it does not presently meet OIKONOMOS's governed per-tool connector contract. This spike made no code, dependency, account, or production configuration change.

### 1. N5, data sovereignty, and R19

N5 restricts OIKONOMOS to Basileia-owned accounts; it does not, by itself, make a hosted processor acceptable. Composio Connect is a hosted MCP endpoint (`https://connect.composio.dev/mcp`). Its documented model creates persistent connected accounts, and Composio stores and refreshes their OAuth tokens. Tool arguments/results and connector traffic therefore traverse a third-party SaaS on the path to the upstream provider. That is exactly R19's unresolved data-sovereignty exposure, rather than a way around it.

Composio's controls reduce but do not eliminate that issue: its pricing page describes zero-data-retention as an optional paid add-on and its KMS proxy as protecting secret storage, explicitly not full data residency. Composio also offers a local sandbox, but it still keeps managed authentication and tool discovery; that is not a self-hosted Connect gateway. The durable-session model makes the exposure sharper: a hosted party holds refreshable connector credentials across sessions, whereas the current design keeps D3 material out of the model namespace by construction.

**N5 verdict:** potentially compatible only with a carefully verified Basileia-owned account and scope configuration; nevertheless **not approved**. An adoption ADR would need a written data-flow and data-residency assessment, DPA/subprocessor and retention commitments suitable for the deployment, revocation/deletion evidence, and proof that no client/employer/third-party account can be connected. It must also decide whether third-party custody of durable OAuth refresh tokens is acceptable under N4/N5/N13. Until then, use the existing first-party/selected-MCP connector pattern.

### 2. Per-tool tier mapping against OIK-047

OIK-047's live schema requires every manifest tool to declare a stable `tool_name`, `capability_id`, and `default_tier`; OIK-049 requires every exposed MCP tool to be mapped, with unmapped tools denied. Role grants and golden-eval records are connector-specific. This is a static, reviewable allowlist whose mapping occurs before exposure to the agent.

Composio Connect instead exposes seven meta-tools. In particular, `COMPOSIO_SEARCH_TOOLS` discovers upstream tools dynamically, `COMPOSIO_GET_TOOL_SCHEMAS` retrieves their schemas, and `COMPOSIO_MULTI_EXECUTE_TOOL` executes one or more discovered tools (up to 50 per call). Mapping just those meta-tools would collapse many materially different upstream effects into one capability/tier and let a post-review catalog change alter the effective action surface. Mapping the discovered tool names after search is too late unless a local broker adapter validates a versioned, allowlisted catalog entry before every execution and denies all unknown actions.

**Tier-mapping verdict:** **not feasible with Connect directly**. A future ADR could evaluate a non-Connect integration only if it supplies a pinned per-tool catalog and a local adapter that: (a) emits one OIK manifest entry per upstream action, (b) performs the existing broker decision on that action before dispatch, (c) denies unknown/new/renamed actions and opaque batch requests, (d) preserves role ceilings and fixed enforced-floor classification, and (e) gives each action independent golden coverage. `MULTI_EXECUTE_TOOL` must remain disabled or be decomposed and individually broker-authorized; it cannot receive a blanket tier.

### 3. Cost against the R30,000/month ceiling

Current public Composio pricing (checked 2026-09-02) is not the immediate budget blocker for ordinary connector calls: Free is hard-capped at 100,000 tool calls/month; Pro is US$29/month plus usage credit and US$0.0003 per ordinary tool call over the included allowance when using own app/API key/MCP. Composio-managed apps reduce the free allowance to 20,000 calls and charge US$0.0005 per subsequent call; optional ZDR adds US$0.0001 per call and BAA adds US$0.0003 per call. Premium tools are separately metered and may dominate (for example, hosted browser automation is listed at about US$0.70 per task).

At the ordinary own-credential overage rate, even 1,000,000 calls is about US$300 before the subscription/add-ons; at the managed-app + ZDR + BAA rate it is about US$1,200 before the subscription. Both are small relative to the project-wide R30,000/month ceiling, but that ceiling also covers inference and hosting, and premium tools/trigger volume have different rates. The free plan's hard cap is safer for a non-production experiment but is not an operational commitment.

**Cost verdict:** ordinary-call pricing is acceptable only behind a per-provider spend cap materially below R30,000 and per-routine broker budgets; premium tools, triggers, and compliance add-ons need separate worst-case modelling. Cost does not cure the sovereignty or governance incompatibilities, so it is not a reason to adopt Connect.

### Sources checked

- OIKONOMOS: Addendum D §2 OIK-164 and §3 R19; CLAUDE.md Budget/N5; `packages/connectors/src/manifest/schema.ts`; ADR-008; Addendum F §§4.3 and 5.
- Composio, [Composio Connect](https://docs.composio.dev/docs/composio-connect) — hosted endpoint, seven meta-tools, dynamic discovery, and multi-execute semantics.
- Composio, [Authentication](https://docs.composio.dev/docs/authentication) and [Connected Accounts](https://docs.composio.dev/reference/api-reference/connected-accounts) — connected-account credential storage/refresh and hosted authentication.
- Composio, [Pricing](https://composio.dev/pricing) — current rates, spend caps, ZDR/KMS limitation, and premium-tool pricing (checked 2026-09-02).

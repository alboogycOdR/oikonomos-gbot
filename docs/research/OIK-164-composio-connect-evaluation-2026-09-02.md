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

---

## Addendum 2026-09-06 — budget ceiling correction (R30,000 → R350)

**Raised by:** ORCH as TASK-200, after the 2026-09-06 human-directed reset of CLAUDE.md's Budget section. **This addendum does not rewrite the 2026-09-02 spike body.** §§1–3 and the headline recommendation remain the historical record, including the R30,000 figure they reasoned against. Pricing numbers below are the spike's own 2026-09-02 figures, re-compared; this addendum does not re-fetch Composio's live price list.

**What changed.** On 2026-09-06 the platform ceiling was reset from R30,000/month to **R350/month (inference + hosting)** — a ~100× reduction. Converted at the documented placeholder rate `DEFAULT_USD_TO_ZAR_RATE = 18.5` (`services/worker/src/subprocessProviders.ts`; "NOT authoritative. Override via `USD_TO_ZAR_RATE`"), that is ~US$18.92/month combined, not ~US$1,622/month.

**What the original cost comparison assumed.** §3 treated ordinary-call pricing as "not the immediate budget blocker": Free = 100,000 tool calls/month hard-capped; Pro = US$29/month plus US$0.0003 per ordinary own-credential overage call; ~US$300 for 1,000,000 ordinary own-credential calls before subscription/add-ons; ~US$1,200 at the managed-app + ZDR + BAA rate before subscription; premium hosted-browser tasks ~US$0.70 each. Both US$300 and US$1,200 were called "small relative to the project-wide R30,000/month ceiling". The cost verdict was: ordinary-call pricing is acceptable only behind a per-provider spend cap materially below R30,000; cost does not cure the sovereignty (§1) or governance (§2) incompatibilities, so it is not a reason to adopt Connect.

**Arithmetic against the new figure** (same 2026-09-02 rates, no new fetch):

| Original §3 quantity | vs ~US$18.92 combined ceiling |
|---|---|
| Pro subscription floor US$29/month | **153% of the entire ceiling** before any tool call |
| ~US$300 for 1M ordinary own-credential calls (ex-subscription) | **~16×** the entire monthly budget |
| ~US$1,200 at managed-app + ZDR + BAA (ex-subscription) | **~63×** the entire monthly budget |
| Premium hosted-browser task ~US$0.70 | **~3.7% of the month per task**; ~27 such tasks exhaust the ceiling |
| Free plan (100,000 calls, $0) | The only quoted price point that fits, and §3 already called it "not an operational commitment" |

Against R30,000 (~US$1,622) the US$300 figure was ~18% of the USD ceiling and the US$1,200 figure was already ~74% of it. Against R350 both dwarf the pot. The original framing that those sums were "small relative to" the ceiling does not hold.

**Verdict — headline recommendation (do not adopt Composio Connect for G1): UNCHANGED, and reinforced. Cost verdict: CHANGED.**

- **Unchanged / reinforced:** do not adopt. §§1–2 (N5 / R19 data-sovereignty; per-tool tier-mapping infeasibility against OIK-047) were independently sufficient and are untouched by the ceiling reset. A tighter budget makes an unmetered / hard-to-cap third-party gateway *less* attractive, not more.
- **Changed:** cost is no longer "not the immediate budget blocker". Ordinary Pro pricing exceeds the entire combined inference+hosting ceiling **at the subscription floor** (US$29 > ~US$18.92). Even if sovereignty and governance were solved tomorrow, Connect's quoted Pro path is unaffordable under R350. The §3 clause "acceptable only behind a per-provider spend cap materially below R30,000" is recast: there is no remaining headroom in which a US$29/month third-party gateway subscription can sit "materially below" a US$18.92 combined ceiling. Cost is now an independent additional reason not to adopt, not merely a non-curative companion to §§1–2.

This addendum does not cut a new ADR, does not change any connector code, and does not authorise a Free-plan experiment. A later, separately scoped ADR evaluation remains possible in principle (as the 2026-09-02 recommendation already allowed) but would have to start from R350, not from R30,000.

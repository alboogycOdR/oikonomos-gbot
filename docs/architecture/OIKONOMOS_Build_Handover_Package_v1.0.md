# OIKONOMOS — Build Handover Package

**Version:** 1.0
**Date:** 2026-08-13
**Owner:** Alister Witbooi, Basileia Technologies
**Purpose:** Convert the OIKONOMOS architecture documents into an executable engineering engagement.
**Audience:** development team, day 1.

---

## 1. Handover readiness verdict

**The two existing documents are NOT sufficient to hand to a development team.** They are a sound architecture and a sound plan. They are not a build package. Handing them over as-is produces divergent interpretations of the broker, no shared definition of done, and no way to tell whether week 3 was a success.

Five deficiencies, all closed by this package or explicitly assigned:

| # | Deficiency | Status |
|---|---|---|
| **D1** | **The broker enforcement contract was wrong.** Both documents specified `canUseTool`; verification shows it is bypassable by a single allow rule. The security model had a hole. | **CLOSED** — ADR-001 (attached). Broker is now a `PreToolUse` hook with four-layer defence and eight canary tests. |
| **D2** | **The documents conflict.** v0.1 puts the browser workspace in Phase 3 with a 5-phase sequential roadmap; v0.2 puts Steel in week 2 across two parallel tracks. A team reading both cannot tell which roadmap governs. | **CLOSED** — §2 document hierarchy with explicit supersession. |
| **D3** | **No repository, no interfaces, no environments.** No monorepo layout, no package boundaries, no API contract between broker and gateway, no dev/stage/prod definition. | **CLOSED** — §3 scaffold + §4 interface contracts. |
| **D4** | **No tickets, no acceptance criteria, no definition of done.** "Build the broker" is not a work item. Nothing states what a reviewer checks before merge. | **CLOSED** — §5 Sprint 1 fully specified, §6 DoD and quality gates. |
| **D5** | **No team shape, no environment runbook, no decision log.** Unclear who is needed, what access they get, and which decisions are still open. | **CLOSED** — §7 team, §8 environments, §9 open decisions requiring your sign-off before day 1. |

**Verdict: hand over this package (v1.0) plus the two architecture documents and ADR-001, after signing off §9.** Not before.

---

## 2. Document hierarchy — what governs what

Precedence, highest first. Where documents conflict, higher wins.

| Rank | Document | Authoritative for | Superseded parts |
|---|---|---|---|
| 1 | **ADR-001** and all subsequent ADRs | Enforcement contract; any decision an ADR addresses | Overrides both specs on broker wiring |
| 2 | **Build Handover Package v1.0** (this) | Roadmap, tickets, DoD, interfaces, environments, team | — |
| 3 | **Gap Closure Plan v0.2** | Gap closures G1–G6, P1–P2; component adoptions; parity scorecard; quality-bar rule | Its §7 roadmap is refined by §5 here; its P1 wiring is replaced by ADR-001 |
| 4 | **Platform Synthesis Spec v0.1** | Schema, risk tiers, approval binding, capability broker design, security posture, harvest lists | **Its §6 five-phase roadmap is SUPERSEDED** by v0.2's two-track model. Its §5.2 `canUseTool` wiring is **SUPERSEDED** by ADR-001. Everything else stands. |
| 5 | Original research document | Background rationale only | Not a build instruction |

**Rule for the team:** if two documents materially disagree and no ADR covers it, do not pick one — escalate to ORCH, who resolves it by updating the lower-precedence document or recording an ADR when the decision needs durable rationale (per CLAUDE.md "Document precedence", amended 2026-09-01). Feature work that does not contradict an existing decision proceeds from its approved task/spec without an ADR.

---

## 3. Repository scaffold

Single monorepo: `basileia/oikonomos`. TypeScript, pnpm workspaces, Vitest. Node 22 LTS.

```
oikonomos/
├── CLAUDE.md                    # project instructions; protected paths; conventions
├── docs/
│   ├── architecture/            # synthesis spec v0.1, gap closure v0.2 (reference copies)
│   ├── decisions/               # ADR-001 ... ADR-NNN
│   ├── runbooks/                # environment setup, incident, kill-switch drill
│   └── connectors/              # one onboarding record per connector (G1 pipeline output)
├── packages/
│   ├── broker/                  # capability broker: PreToolUse endpoint, policy, approval verify
│   ├── policy/                  # pure-function risk-tier policy module (no I/O, 100% branch cov)
│   ├── approvals/               # approval service: issue, bind, verify, consume, expire
│   ├── audit/                   # append-only writer + redaction middleware
│   ├── agent-providers/         # extracted AgentProvider (Claude Code / Codex / Grok Build)
│   ├── harness-factory/         # THE ONLY path to construct a harness invocation (ADR-001 cost)
│   ├── db/                      # schema migrations, typed queries, pgvector access
│   ├── connectors/              # MCP registration pipeline + per-connector manifests
│   ├── memory/                  # profile_facts, org_facts (OME), retrieval w/ ACL pre-filter
│   └── shared/                  # Zod schemas, types, errors, canonical JSON, digest utils
├── services/
│   ├── control-api/             # Fastify: tasks, runs, approvals, evidence, admin
│   ├── worker/                  # pg-boss consumers; run execution; resume
│   ├── gateway-telegram/        # existing bot, refactored to consume control-api
│   └── workspace/               # Steel Browser config, egress proxy, session lifecycle
├── apps/
│   ├── dashboard/               # React + PWA (week 3)
│   └── mobile/                  # Flutter control client (week 3+)
├── evals/
│   ├── golden/                  # per-connector golden tasks (G1 quality bar)
│   └── harness/                 # eval runner + scorecard output
└── infra/
    ├── compose/                 # docker-compose per environment
    ├── images/                  # per-agent workspace golden image
    └── ci/                      # GitHub Actions: canaries, tests, lint, license scan
```

**Protected paths** (CLAUDE.md, review required): `packages/broker/**`, `packages/policy/**`, `packages/approvals/**`, `packages/harness-factory/**`, `infra/ci/**`, all settings/subagent configs, `docs/decisions/**`.

**Conventions:** Conventional Commits; trunk-based with short-lived branches; every PR links a ticket ID; Fable adversarial review required on protected-path changes.

---

## 4. Interface contracts (build against these, not prose)

### 4.1 Broker endpoint — `POST /v1/broker/pretooluse`

Called by the `PreToolUse` hook (L1) and, idempotently, by `canUseTool` (L3).

```typescript
// Request
{
  toolUseId: string;          // idempotency key (R2)
  runId: string;              // uuid
  roleId: string;
  tenantId: string;           // 'basileia'
  toolName: string;           // 'mcp__gmail__send_message' | 'Bash' | ...
  input: Record<string, unknown>;
  agentRef: { provider: string; sessionRef: string; isSubagent: boolean };
  approvalNonce?: string;     // present only on approved retry
}

// Response — exactly one of:
{ decision: "allow";  tier: RiskTier; auditEventId: string; updatedInput?: Record<string, unknown> }
{ decision: "deny";   reason: string; auditEventId: string }
{ decision: "deny";   reason: "approval_pending"; approvalId: string; auditEventId: string }
```

Hook adapter maps `allow` → hook pass-through, both `deny` forms → hook deny with message. **Any transport failure, timeout (>10 s), or unparseable body ⇒ hook denies (R3).**

### 4.2 Capability → tier resolution

`effectiveTier = max(capabilities.default_tier, roleGrantOverride)` — the **more restrictive** wins. No path grants a role a lower tier than a capability's default. Unregistered `toolName` ⇒ deny (fail closed), audit as `capability.unregistered`.

### 4.3 Approval binding (unchanged from v0.1 §5.2, restated as contract)

```
action_digest = sha256(canonicalJson({ toolName, input, destination }))
```
Canonical JSON: sorted keys, no whitespace, UTF-8, numbers in shortest round-trip form. **`packages/shared` owns the single implementation** — no reimplementation anywhere else.

Consumption is one atomic statement; row count 1 or the action does not run:
```sql
UPDATE approvals SET status='consumed', consumed_at=now()
WHERE nonce=$1 AND status='granted' AND expires_at>now() AND consumed_at IS NULL;
```

### 4.4 Connector manifest (`docs/connectors/<id>.yaml`) — G1 pipeline artifact

```yaml
connector_id: gmail
account_ownership: basileia                        # REQUIRED; onboarding rejects any other value
mcp_server: { name: gmail, transport: remote, url_ref: secret://mcp/gmail/url }
oauth_scopes: [gmail.readonly, gmail.compose]     # NO gmail.send in wave 1
tools:
  - tool_name: mcp__gmail__list_messages
    capability_id: email.list
    default_tier: T0_observe
  - tool_name: mcp__gmail__create_draft
    capability_id: email.create_draft
    default_tier: T1_draft
  - tool_name: mcp__gmail__send_message
    capability_id: email.send
    default_tier: T3_external
    enabled: false                                 # until governance exit
role_grants:
  - role_id: inbox-triage
    max_tier: T1_draft
    constraints: { rate_per_hour: 40, domains: ["*"] }
evals: { suite: evals/golden/gmail, min_pass_rate: 0.90 }
review: { onboarded_by: "", date: "", scope_justification: "" }
```

---

## 5. Sprint 1 (week 1) — fully specified

**Sprint goal:** P1 is true and proven. Nothing else in the platform is trustworthy until this sprint's canaries are green.

| ID | Ticket | Acceptance criteria | Est |
|---|---|---|---|
| OIK-001 | Monorepo scaffold + CI skeleton | pnpm workspaces build; lint, typecheck, test jobs run on PR; CLAUDE.md protected paths enforced by CODEOWNERS | 0.5 d |
| OIK-002 | Postgres 16 + pgvector on clawsrv, Tailscale-bound | Migration runner applies v0.1 §5.1 schema; append-only rules verified (UPDATE/DELETE are no-ops); connection refused from non-Tailscale interface | 1 d |
| OIK-003 | `packages/shared`: canonical JSON + digest | Property tests: key order, unicode, number forms, nesting all produce stable digests; two independent inputs never collide in fixture set | 0.5 d |
| OIK-004 | `packages/policy`: pure-function tier resolution | 100% branch coverage; unregistered capability ⇒ deny; more-restrictive-wins verified; zero I/O imports (lint rule) | 1 d |
| OIK-005 | `packages/approvals`: issue/verify/consume | CAN-06 replay and CAN-07 mutation tests pass; expiry honoured; concurrent consume attempts ⇒ exactly one success (DB-level test) | 1.5 d |
| OIK-006 | `packages/audit`: append-only writer + redaction | Every decision written incl. denials; secret-pattern redaction unit-tested; UPDATE/DELETE attempts fail | 1 d |
| OIK-007 | `packages/broker`: PreToolUse endpoint per §4.1 | All response shapes; idempotent per `toolUseId` (CAN-08); fails closed on timeout (CAN-04) | 1.5 d |
| OIK-008 | `packages/harness-factory`: sole harness constructor | Configures L1 hook + L2 `dontAsk` + `allowedTools` + L3 callback; lint rule fails build on any direct `query()` call outside this package | 1 d |
| OIK-009 | **Canary suite CAN-01…CAN-08 wired CI-blocking** | All eight pass; **CAN-02 explicitly demonstrates the allow-rule bypass is defeated**; CAN-03 greps repo clean of banned modes | 1 d |
| OIK-010 | Per-agent Docker isolation (G6 rung 1) | Two agents; own volumes/network namespace/quotas; chaos test: agent A disk-fill/crash/loop cannot affect agent B | 1.5 d |
| OIK-011 | ADR-001 committed + monthly SDK-drift watch job | ADR in `docs/decisions/`; scheduled job opens a ticket if SDK permissions page changes | 0.5 d |

**Sprint 1 exit gate (all must hold):** CAN-01…CAN-08 green in CI · zero `bypassPermissions`/`acceptEdits` in repo · Fable adversarial review of `broker`+`policy`+`approvals` complete with findings closed · chaos test passing.

**Until this gate passes, no connector work, no Steel deployment, no Tier-3 capability is enabled.** Track B (§v0.2) may proceed on non-executing work only: connector manifests authored, evals written, Steel deployed but unregistered.

---

## 6. Definition of Done & quality gates

**Every PR:** ticket linked · types strict, no `any` in protected packages · unit tests for new branches · no secrets in code/logs/fixtures · Conventional Commit · docs updated if contract changed.

**Every feature — the v0.2 §2 four-part bar, made checkable:**
1. **Functional** — a real workflow completes end-to-end (not a demo path); demo recorded.
2. **Governed** — every action through the broker; Tier-3 bound-approval; denials audited. Evidence: audit query in the PR.
3. **Evidenced** — the run answers: what data, what actions, what changed, what approved, how to stop/reverse.
4. **Evaluated** — golden-task suite ≥ stated pass rate; suite runs in CI thereafter.

**Release gates:** Governance exit (end wk 3) unlocks Tier-3 for `inbox-triage` only · per-connector Tier-3 unlocks individually on eval pass · full-platform Fable pass before wk-8 parity review.

**Non-negotiables (build-failing):** no CAPTCHA/MFA/bot-protection circumvention (Steel stealth disabled — asserted in config test) · no credentials in prompts/logs/audit · no `bypassPermissions`/`acceptEdits` · ACL filter before vector similarity, never after (query-shape test) · fail-closed everywhere · **scope boundary: connectors resolve to Basileia-owned accounts only — every connector manifest carries `account_ownership: basileia` and onboarding review rejects any target outside that boundary (§9 S7).**

---

## 7. Team shape

| Role | FTE | Owns | Must have |
|---|---|---|---|
| **Platform/backend lead** | 1.0 | broker, policy, approvals, audit, control-api | TypeScript, Postgres, security-critical code; ADR authority |
| **Agent/integrations engineer** | 1.0 | harness-factory, agent-providers, connector pipeline, evals | Agent SDK, MCP, OAuth scope discipline |
| **Infra/platform engineer** | 0.5–1.0 | Docker isolation, Steel, egress proxy, CI, observability, workspace images | Linux, containers, networking, Tailscale |
| **Frontend/mobile** | 1.0 (from wk 3) | dashboard PWA, Flutter client | React + Flutter/FCM |
| **Adversarial reviewer ("Fable")** | 0.25 | protected-path reviews, threat modelling | Can be Alister or a rotating role — but must not be the author |

Minimum viable start: platform lead + agent engineer + half-time infra. Frontend joins week 3.

---

## 8. Environments

| Env | Where | Purpose | Rules |
|---|---|---|---|
| `local` | developer machine, docker-compose | unit/integration | Mock MCP servers only. **No real credentials, ever.** |
| `dev` | clawsrv namespace `oik-dev` | integration, canaries, evals | Sandbox/test accounts only; Tier-3 permanently disabled |
| `prod` | clawsrv namespace `oik-prod` | real work | Real accounts; Tier-3 gated per §6; Tailscale-only ingress; daily encrypted backup of Postgres + evidence volume |

Secrets: age-encrypted per environment, systemd credentials at runtime; OpenBao at Phase 3 (v0.1 O4). No secret ever enters a prompt, log, audit payload, or eval fixture.

---

## 9. Open decisions requiring your sign-off BEFORE day 1

| # | Decision | Recommendation | Impact if deferred |
|---|---|---|---|
| **S1** | Ratify ADR-001 (broker = PreToolUse; `bypassPermissions`/`acceptEdits` banned platform-wide) | **Accept** | Blocks all of Sprint 1 |
| **S2** | Ratify document hierarchy §2 — v0.1's 5-phase roadmap is dead; two-track model governs | **Accept** | Team builds to conflicting roadmaps |
| **S3** | Team size and start date; is the platform lead you, or a hire/contractor? | Not mine to call — but the 8-week roadmap assumes ~2.5 FTE from week 1 | Roadmap dates are fiction without this |
| **S4** | Budget ceiling: inference (FreeLLMAPI routing), Steel hosting, connector subscriptions, VPS uplift for per-agent isolation | Set a hard monthly Rand ceiling now; broker enforces per-routine budgets from wk 5 | Risk #1 from v0.1 §9 materialises unbounded |
| **S5** | Wave-1 connector list — confirm the 10 from v0.2's priority-25 that matter most to *your* workflows | Suggest: Gmail, Calendar, Drive, Docs, Slack, GitHub, Notion, Jira, Confluence, Telegram | Team picks for you, probably wrong |
| **S6** | Is this Basileia-internal only, or a future client/commercial product? | Materially changes: AGPL components (Honcho, Daytona), multi-tenancy timing, POPIA posture, Firecracker gate | Cheap now, expensive at week 6 |
| **S7** | Ratify the scope boundary: OIKONOMOS operates exclusively on Basileia-owned accounts, systems, and data. Client, employer, and third-party contract environments are **out of product scope**. | **Accept** — confirmed by the product owner. This is a scope definition, not a risk control. | Scope creep via connector onboarding; a reviewer with no stated boundary has nothing to reject against |

---

## 10. Where to from here — the sequence

1. **You:** sign off §9 S1–S7. Nothing starts before S1 and S2.
2. **You/Fable:** adversarial pass on ADR-001 and this package — priority targets: the fail-closed paths (R3), and the connector-onboarding review as the enforcement point for the §9 S7 scope boundary.
3. **Team day 1:** repo scaffold, Postgres, ADR-001 committed. Sprint 1 board loaded from §5.
4. **Week 1 end:** Sprint 1 exit gate. **Do not proceed past a red gate** — a bypassable broker at week 1 is a compromised platform at week 8.
5. **Weeks 2–8:** v0.2 §7 two-track roadmap, refined per §2 precedence; per-connector Tier-3 unlocks on eval pass; wk-8 parity review against v0.2 §8 scorecard.
6. **Standing:** monthly SDK-drift check (ADR-001); every conflict becomes an ADR; every protected-path change gets a Fable pass.

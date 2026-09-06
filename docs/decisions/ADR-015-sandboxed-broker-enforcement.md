# ADR-015: Broker HTTP Surface for Sandboxed Harness Execution (OIK-084)

**Status:** Proposed — first-pass design by ORCH (Sonnet 5), 2026-09-06. This is the same
model/reviewer as the author of most of this session's own builder work; per this
project's own discipline (see ADR-014's history), this needs an adversarial review by
a different model (Fable/Opus) before it can be treated as Accepted. Do not build
against this until it clears that review or the human explicitly overrides.

**Date:** 2026-09-06

**Author:** ORCH (Claude Sonnet 5), first-pass design requested by the human after
TASK-170 (route real chat execution through an OpenSandbox sandbox) found this gap
mid-implementation and correctly refused to build a workaround.

**Related:** ADR-001 (broker enforcement point — the invariant this decision must
preserve), ADR-006 Addendum B (OpenSandbox adoption), ADR-010 (persistent office
computer / sandbox-per-role), CLAUDE.md non-negotiable #1, TASK-169 (execd client,
done), TASK-170 (blocked pending this decision), OIK-084 (the long-deferred broker
HTTP surface this ADR finally specifies).

## Context

TASK-170 needs the Claude Agent SDK harness to actually run **inside** an OpenSandbox
container — reached via `execd`'s `/command` endpoint (TASK-169), a bare subprocess
invocation, not an SDK-orchestrated session — while still enforcing ADR-001's
invariant: **every tool invocation an agent attempts is intercepted by the broker
before execution**, with fail-closed semantics on any broker failure.

Investigating the actual code (not the resolution doc's assumptions) found the
following, confirmed by direct reading:

1. **The only existing enforcement mechanism is an in-process JS callback.**
   `createHarness` (`packages/harness-factory/src/index.ts`) builds a `hooks.PreToolUse`
   array containing `adaptL1(deps.l1)` and passes it as `options.hooks` directly into
   the Agent SDK's `query()` call. This works today because `query()`'s orchestration
   and the broker's `handlePreToolUse` run in the **same OS process** — the "HTTP" port
   (`createInProcessBrokerPort`, `packages/harness-factory/src/compose.ts`) is a fake
   `fetch` that never leaves memory; `baseUrl` is a placeholder
   (`http://oikonomos.broker.local`) that is never actually resolved over a network.

2. **There is no mechanism today to wire a PreToolUse hook into a bare `claude -p`
   subprocess that the SDK's `query()` does not itself spawn.** Every `claude -p`
   invocation elsewhere in this repo (ORCH/dispatch/autopilot tooling —
   `scripts/dispatch.ps1`, `scripts/supervisor.py`) runs with
   `--dangerously-skip-permissions` and carries **zero** enforcement — which is fine for
   those (operator-supervised, not governed agent execution) but is exactly the banned
   mode CLAUDE.md non-negotiable #2 prohibits for a governed harness run.

3. **`OIK-084` — the broker's real HTTP surface — has never been built, anywhere, in
   this project's history.** `packages/broker/src/index.ts` has said "the HTTP adapter
   (OIK-084) maps timeout, non-2xx, and invalid JSON failures to this error before they
   reach the broker" since the broker's very first implementation (TASK-016/017 era).
   Every chat run to date has executed in-process on the host, so this was never
   forced into existence. TASK-170 is the first task that genuinely needs the broker
   reachable **across a process/network boundary**.

4. **This project already has a working, in-use example of exactly the mechanism
   needed**: `hooks/territory-firewall.js` is a real, standalone, external-process
   Claude Code `PreToolUse` hook, registered in `.claude/settings.json`:
   ```json
   "PreToolUse": [{
     "matcher": "Edit|Write|MultiEdit|NotebookEdit",
     "hooks": [{ "type": "command", "command": "node hooks/territory-firewall.js" }]
   }]
   ```
   Its own header documents the exit-code contract: **exit 0 = allow, exit 2 = block
   (stderr fed back to the model as the reason)**. This is a *different* mechanism from
   the SDK's in-process `hooks` option used today by `createHarness` — it is Claude
   Code CLI's own external-command hook contract, and it is provably real because this
   project's own devteam tooling depends on it working correctly right now.

**Open question this ADR does NOT resolve** (flagged explicitly, not guessed): the
*complete* stdin JSON schema Claude Code sends to an external PreToolUse hook script
(beyond the one field, `tool_input`, this repo's own hook code happens to read), and
whether any richer response mechanism exists beyond the plain exit-code contract
(e.g. a stdout-JSON "ask" response), are **not documented anywhere in this
codebase**. Whoever implements this must verify the exact payload shape against
Claude Code's own current hook documentation before writing the sandboxed hook
script — do not assume the shape from this ADR's sketch below.

## Decision

**Run the full harness (`claude -p`) inside the sandbox as a bare CLI subprocess, and
enforce PreToolUse via Claude Code's own external-command hook mechanism, calling out
to a new, real, network-reachable broker HTTP endpoint.** This reuses a
mechanism already proven to work in this exact project (`territory-firewall.js`)
rather than inventing a new one, and it requires zero changes to
`packages/broker`'s pure decision logic or to the `BrokerHttpPort` interface itself —
`createInProcessBrokerPort` remains the correct, unchanged implementation for every
host-executed (non-sandboxed) run; this ADR adds a second, real implementation for
the sandboxed case.

An alternative was considered and rejected: keep `query()`'s orchestration on the
host (unchanged, in-process hooks) and instead redirect only the *tool execution*
(Bash/Read/Write's actual work) to the sandbox remotely, leaving PreToolUse
untouched. This was rejected as the primary path because the Agent SDK does not
document a supported way to override where its built-in tools physically execute —
pursuing it would mean reverse-engineering internals with materially higher risk of a
silent, undetected enforcement gap (exactly ADR-001's F1 failure mode: "a tool
approved... never reaches `canUseTool`... the broker would not log a denial; it would
log nothing at all"). If a reviewer identifies a documented SDK extension point for
this, it should be reconsidered — but do not build against an undocumented one.

### 1. New broker-decision route on `services/control-api`, not a new service

`services/control-api` is the only existing long-lived, authenticated HTTP-listening
service in this codebase (`services/worker` has zero HTTP-serving capability today —
confirmed by reading `services/worker/src/index.ts` and its `package.json`, which
declares no HTTP framework dependency at all). Add `POST /v1/broker/pretooluse` to
`control-api`'s existing Fastify app rather than standing up a new service — it
reuses the existing Tailscale-reachable deployment, existing bearer-auth
infrastructure, and existing operational surface instead of adding a second thing to
deploy, monitor, and secure.

The route is a thin wrapper calling `handlePreToolUse` directly (the same pure
function `createInProcessBrokerPort` already calls) — genuinely serving the request
over the network this time, mapping `PreToolUseRequest`/`PreToolUseResponse`
(`packages/broker/src/index.ts`) verbatim, no new decision logic.

**Auth is a new, separate, narrowly-scoped bearer token — never `CONTROL_API_TOKEN`.**
`CONTROL_API_TOKEN` authenticates operator/user access to the full management API
surface (roles, threads, approvals, everything). A sandboxed tool call is a much
lower-trust caller — if a malicious or compromised prompt inside a sandbox ever
tricked the hook script into leaking its own token, that token must not unlock
anything beyond broker decisions. Add a new `BROKER_ACCESS_TOKEN` env var, checked at
this route only (not the app's global auth), using the same `timingSafeEqual`
comparison `services/control-api/src/auth.ts` already establishes as the house
style — no new comparison primitive invented.

New secret, following the existing `secret://` convention exactly
(`packages/sandbox-client/src/secretResolver.ts`'s pattern):
`secret://broker/access_token` → `OIK_SECRET_BROKER_ACCESS_TOKEN`. Resolved via an
injectable `SecretResolver`, mirroring `resolveExecdAccessToken`/`execdAccessTokenRef`
exactly.

**Fail-closed, per ADR-001 R3** (10s deadline): the route itself should apply a
defensive server-side bound consistent with `BrokerFailure`'s existing taxonomy
(`broker.timeout`, `broker.http_500`, `broker.malformed_response`,
`packages/broker/src/index.ts`), but the *authoritative* deadline enforcement is the
hook script's own client-side timeout (below) — a slow-but-eventually-successful
server response must still count as a timeout from the hook's perspective if it
exceeds 10s, matching every other broker caller in this codebase.

### 2. New standalone hook script, baked into the sandbox image

A new script (exact location TBD by whoever implements this — a natural home is
alongside `packages/harness-factory` since this is the harness's own sandboxed
execution concern, or a small new package if it needs to ship as a standalone
artifact into the sandbox image) implementing the **exact same exit-code contract**
`hooks/territory-firewall.js` already uses: **exit 0 = allow, exit 2 = block, reason
on stderr**. It is:

- Registered via a `.claude/settings.json` written into the sandbox's
  `/workspace/<role>` cwd (TASK-175's carved `runWorkspace.ts` is the natural place
  to write this alongside the workspace setup, matching how the image has
  deliberately no pre-existing `~/.claude.json`/`.mcp.json`, per TASK-154).
- Reads the tool-call payload from stdin (confirmed available: `tool_input` at
  minimum; verify the complete schema against Claude Code's own hook documentation
  before implementing — see the Open Question above).
- Maps it into `PreToolUseRequest`'s exact shape. Note `toolUseId`/`toolName`/`input`
  come from the hook payload, but `runId`/`roleId`/`tenantId`/`agentRef` do **not** —
  the hook payload has no reason to carry those, and they must not be *inferred* by
  the script (that would be exactly the "caller-supplied prose" ADR-004 already
  rejects for approval cards). Instead, inject them as **explicit environment
  variables** at `runCommand` invocation time — the same discipline TASK-169/170
  already established for `EXECD_ACCESS_TOKEN` and TASK-153's "no host env, only
  explicitly-passed values" guarantee. The worker, which already knows the real
  `runId`/`roleId`/`tenantId` for this chat turn, is the only party positioned to
  supply them correctly.
- POSTs to the new endpoint (URL also supplied via env — Tailscale-reachable,
  resolved the same way `SANDBOX_INTEGRATION_URL` is today) with the bearer token,
  applying a hard 10-second client-side timeout per ADR-001 R3.
- On `{decision: "allow", ...}` → exit 0. On `{decision: "deny", reason, ...}`,
  `approval_pending`, a timeout, a non-200 response, or any malformed/unparseable
  body → exit 2, writing the reason to stderr. **Every one of these is a block, with
  no separate "ask" path** — this project has no approval-prompt UI reachable from
  inside a sandbox, so `approval_pending` here means the run parks exactly as it
  already does for a host-executed T3+ call (TASK-131's pattern), not that the hook
  itself blocks forever waiting for a human.

### 3. Liveness assertion (ADR-005)

This is a new mechanical control — it needs its own liveness assertion, not just a
correctness test, per CLAUDE.md's "every mechanical control ships a liveness
assertion" rule. The assertion should key on **observed evidence the hook actually
ran and reached a real decision**, not on the hook script or settings.json merely
being present in the sandbox image — e.g., an integration test that removes/breaks
the hook registration and confirms an otherwise-identical undeclared tool call is no
longer denied (mirroring exactly how TASK-194's liveness test proved
`describeOrDeny` was wired by showing what breaks when it isn't). TASK-170's own AC
("a tool call from inside the sandbox that the broker denies must be observed
denied... the assertion keys on the hook's denial event, not on config") already
anticipates this correctly.

### 4. Consequences

- **A genuinely new trust boundary and attack-surface class.** Anyone who can reach
  this endpoint over Tailscale *and* holds the token can request broker decisions.
  The token must be real (not a placeholder), rotatable, and never logged — same
  discipline as every other credential in this codebase (CLAUDE.md non-negotiable #4).
  This is exactly the kind of surface TASK-170's own Description already flagged
  ("this genuinely opens a new attack-surface class") and TASK-185's iptables work is
  adjacent to (defense in depth at the network layer beneath this).
- **First real network-latency exposure for the broker decision path.** Every prior
  caller was in-process (sub-millisecond). This route introduces genuine network
  round-trip latency into the hot path of every tool call inside a sandboxed run.
  TASK-170's own AC to "investigate real latency... report actual numbers, don't
  assume" now applies to this hop specifically, not just sandbox resolve/create.
- **`createInProcessBrokerPort` is unaffected and remains correct** for every
  non-sandboxed run — this ADR does not deprecate or change it.
- **A pre-existing, minor type-duplication issue was found during this
  investigation, worth fixing alongside this work but not blocking on it**:
  `packages/harness-factory/src/compose.ts` defines its own
  `BrokerDecisionRequest`/`BrokerDecisionResponse` types that must be kept
  structurally identical to `packages/broker/src/index.ts`'s
  `PreToolUseRequest`/`PreToolUseResponse` by convention rather than by import. The
  new HTTP route is a second place this contract must stay in sync — consider
  importing the real types directly rather than adding a third hand-copied shape.

## Resolution — for whoever implements TASK-170 against this ADR

Once this ADR clears adversarial review (or is otherwise explicitly accepted), the
concrete task shape is approximately:

1. A new task (or TASK-170's own scope, ORCH to decide at that point) adding
   `POST /v1/broker/pretooluse` + `BROKER_ACCESS_TOKEN` auth to `services/control-api`
   — protected-adjacent (calls into `packages/broker`), same different-model review
   discipline as the rest of this wave.
2. The standalone hook script + its packaging into the sandbox image / written into
   the workspace at session start, with the exit-code contract verified against
   Claude Code's real, current hook documentation (the explicit open question above)
   before being trusted.
3. TASK-170 itself: wire `runWorkspace.ts`'s sandbox-backed path to inject the
   `runId`/`roleId`/`tenantId`/broker-URL/broker-token env values into the `/command`
   call, invoke `claude -p` as the entrypoint, and prove the liveness assertion from
   §3 above actually fails when the hook is removed.

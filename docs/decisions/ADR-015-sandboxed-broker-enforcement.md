# ADR-015: Broker HTTP Surface for Sandboxed Harness Execution (OIK-084)

**Status:** Accepted — Accept-with-changes verdict from Fable 5.1's adversarial
review (`docs/decisions/ADR-015-review-fable-2026-09-06.md`, commit `f2716f5`), all
six required changes applied below by ORCH. Change 1's decision gate (a time-boxed
spike) was run live against the real clawsrv server; its result is recorded honestly
in §Decision as **inconclusive, not a clean pass** — Path A (below) is therefore the
implemented decision, with Path B left open as a follow-up for whoever has more time
or execd server-source access. Re-review by Fable is invited on the spike result and
the six applied changes before this is built against.

**Date:** 2026-09-06 (first-pass draft), amended 2026-09-06 after Fable's review and
ORCH's live spike.

**Author:** ORCH (Claude Sonnet 5), first-pass design requested by the human after
TASK-170 (route real chat execution through an OpenSandbox sandbox) found this gap
mid-implementation and correctly refused to build a workaround.

**Reviewer:** Fable 5.1 (different model from the author — satisfies CLAUDE.md's
different-model requirement for `docs/decisions/**`).

**Related:** ADR-001 (broker enforcement point — the invariant this decision must
preserve), ADR-006 Addendum B (OpenSandbox adoption), ADR-010 (persistent office
computer / sandbox-per-role), CLAUDE.md non-negotiable #1, TASK-169 (execd client,
done), TASK-170 (blocked pending this decision), OIK-084 (the long-deferred broker
HTTP surface this ADR finally specifies).

## Context

TASK-170 needs the Claude Agent SDK harness to actually run **inside** an OpenSandbox
container — reached via `execd`'s `/command` endpoint (TASK-169) — while still
enforcing ADR-001's invariant: **every tool invocation an agent attempts is
intercepted by the broker before execution**, with fail-closed semantics on any
broker failure.

**Corrected per Fable's review (change 1) — the original premise here was wrong.**
The first draft of this ADR claimed cross-process hook enforcement was novel to this
project. It is not. Fable verified against the installed Agent SDK
(`@anthropic-ai/claude-agent-sdk` 0.3.233) and CLI (`claude` 2.1.263) that `query()`
already spawns the `claude` CLI as a **child process** over a stdio JSON transport
(`ProcessTransport`), and every `PreToolUse` hook decision already crosses that
process boundary today as a `hook_callback` control request the worker process
answers. **Only the broker port behind the hook (`createInProcessBrokerPort`) is
in-process** — it answers that already-cross-process hook callback with an in-memory
function call instead of a real network round trip. TASK-170 changes *where the
child process lives* (inside a sandbox instead of on the host), not whether a hook
can cross a process boundary at all.

What is still true from the original investigation:

1. `packages/broker/src/index.ts` has said "the HTTP adapter (OIK-084) maps timeout,
   non-2xx, and invalid JSON failures to this error before they reach the broker"
   since the broker's first implementation (TASK-016/017 era) — this has never been
   built, because no prior task needed the hook callback answered by anything other
   than the same-process SDK caller.
2. This project already has a working, in-use example of a *different* but relevant
   mechanism: `hooks/territory-firewall.js`, a real, standalone, external-process
   Claude Code `PreToolUse` hook registered in `.claude/settings.json`, with a
   documented exit-code contract (**exit 0 = allow, exit 2 = block**, stderr fed back
   to the model as the reason). This is Claude Code CLI's external-command hook
   contract — a different wiring path from the SDK's in-process `hooks` option
   `createHarness` uses today, but a real, currently-working one in this exact repo.

**The stdin-schema question from the first draft is resolved, not open.** Fable
found the typed hook input in the installed SDK's own type declarations
(`sdk.d.ts`, `BaseHookInput` + `PreToolUseHookInput`):
```
session_id, transcript_path, cwd, prompt_id?, permission_mode?, agent_id?, agent_type?,
hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id
```
`agent_id` is present only when the hook fires inside a subagent — this is the
CAN-05 subagent-attribution signal. There is also a **richer response than a bare
exit code**: exit 0 plus a stdout JSON body,
```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow|deny|ask",
 "permissionDecisionReason":"...","updatedInput":{...}}}
```
which is required here because `mapBrokerDecision` already supports
`updatedInput` and a bare exit code cannot carry it. **Pin the sandbox image's CLI
version** (`claude` 2.1.263 or whatever is current at build time) so this contract
doesn't drift silently under ADR-001's own monthly re-verification job.

## Decision

### Path A vs. Path B, and the spike result

Fable identified a materially better alternative to the first draft's design and
required a time-boxed spike before committing to a primary path:

| Path | New trust boundary | ADR-001 layers preserved | Status after spike |
|---|---|---|---|
| **A** — external command hook + new broker HTTP route | Yes — a credential now lives inside the sandbox | L1 only, unless separately rebuilt (see §4) | **Implemented below** |
| **B** — `spawnClaudeCodeProcess` over execd's session/pty transport, `query()` orchestration stays on the host | No new credential, no new network-reachable broker endpoint | L1, L2, L3, PostToolUse, park, approval nonces — all preserved, byte-for-byte | **Inconclusive — see below** |

Path B is real and not speculative: the installed SDK exposes a documented extension
point for exactly this (`sdk.d.ts` ~line 2110):
```
/**
 * Custom function to spawn the Claude Code process.
 * Use this to run Claude Code in VMs, containers, or remote environments.
 * ...
 *   return myVMProcess; // Must satisfy SpawnedProcess interface
 */
spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess;
```
`SpawnedProcess` is a small interface (`stdin`, `stdout`, `exitCode`, `killed`,
`kill()`, `exit`/`error` events) — if execd exposes a real bidirectional stdio
transport, a `SpawnedProcess` implementation bridging it is not a research project.

**ORCH ran the spike live against the real clawsrv server rather than leaving it as
a TODO.** Findings, honestly reported:

- `POST .../proxy/44772/session` is real and works — it returns a `session_id` (200)
  and was exercised repeatedly during the spike.
- `.../session/{id}/ws` **is a genuine WebSocket upgrade endpoint** — confirmed by a
  real handshake completing when reached through the lifecycle server's Tailscale
  proxy path (`:8080/v1/sandboxes/{id}/proxy/44772/session/{id}/ws`). This alone is
  a materially positive signal: the transport Path B needs is not hypothetical.
- However, **every attempted message after connecting closed the socket immediately
  with code 1008 (Policy Violation) and an empty reason string** — tried: a raw text
  command, a JSON-framed message mirroring `/command`'s own event shape
  (`{"type":"stdout",...}`), a binary frame, sending nothing at all (still closed
  quickly), and moving auth from headers to query parameters (in case the proxy hop
  drops custom headers on a WS upgrade specifically, which regular HTTP calls
  through the same proxy do not). None of these produced a stdout echo or kept the
  socket open. Connecting to the sandbox's directly-published port (bypassing the
  lifecycle proxy, `use_server_proxy=false`) instead failed the handshake outright
  (`Unexpected server response: 404`) — the WS route only exists behind the proxy
  path, unlike `/command`/`/session` which work on both.
- No cached copy of execd's own server source or the upstream `opensandbox`
  JS/Python SDK was found locally to check the exact wire protocol against, and the
  live server exposes no OpenAPI/docs endpoint for execd itself (only the lifecycle
  server at `:8080` has one, and it does not cover execd's session/ws routes at all
  — confirmed by grep, zero hits for `pause`... no, correction: zero hits for
  `session`/`pty` in that spec).

This is a **real, positive, but incomplete result** — not the clean "spike passes,
Path B is primary" outcome Fable's decision gate hoped for, and not a "spike fails,
record the concrete failure" outcome either, since the failure mode (1008 on message,
not on connect) strongly suggests a solvable protocol detail rather than a dead end.
Per Fable's own framing ("If yes → B is primary, no → record the concrete failure and
keep A"), an inconclusive result defaults to **A**, recorded honestly as provisional
rather than final. **Path B should be revisited** by whoever has either more time for
protocol-level WebSocket debugging or actual read access to execd's server source —
the transport is real; only the exact framing/handshake for the session WS route is
unresolved. If that follow-up spike succeeds, Path B becomes a strictly better
replacement for everything in §1–§4 below (per Fable's own note: "changes 2–5
collapse to the transport bridge plus the managed-settings hardening from change
3.4").

### Path A, as implemented (with all required hardening from Fable's review)

**Run the full harness (`claude -p`) inside the sandbox as a bare CLI subprocess, and
enforce PreToolUse via Claude Code's own external-command hook mechanism, calling out
to a new, real, network-reachable broker HTTP endpoint.**

#### 1. New broker-decision route, on its own listener (change 5)

`services/control-api` is the only existing long-lived, authenticated
HTTP-listening service in this codebase (`services/worker` has zero HTTP-serving
capability — confirmed, no HTTP framework dependency in its `package.json`). The new
route lives in the same process as `control-api` for operational simplicity, but
**binds a second Fastify instance to its own, separate port** — not the same
listener as every other management route. Fable's reasoning is decisive: iptables
and Tailscale ACLs filter by port, not by path, so a route merely *excluded from the
global auth `preHandler` by allowlist* on the shared listener still leaves every
other management route one bearer token away from anything that can reach that
port. Excluding by construction (a different port entirely) is the only version of
this that a network-layer control can actually enforce. Required tests: a request
carrying `CONTROL_API_TOKEN` is rejected on the broker route; a request carrying the
broker token is rejected on every other route.

The route is a thin wrapper calling `handlePreToolUse` directly (the same pure
function `createInProcessBrokerPort` already calls), mapping
`PreToolUseRequest`/`PreToolUseResponse` (`packages/broker/src/index.ts`) verbatim —
import the real types rather than hand-copying a third shape (the pre-existing
`compose.ts` duplication noted in §4 is exactly the mistake not to repeat here).

#### 2. Auth is bound to identity, not a shared secret (change 2)

**A static shared token is not sufficient**, and the first draft of this ADR was
wrong to propose one. As designed, the sandboxed agent's own Bash tool can read
whatever token and run-identity values are injected as env vars for the hook script
(Bash inherits the same env), then `curl` the broker route directly, claiming any
`roleId`/`tenantId`/`runId` the request body carries. The route as originally
sketched cannot distinguish that forged request from the real hook's.

- Mint a **per-turn token**, server-side, in the worker, bound to the specific
  `runId`, `roleId`, `tenantId`, and `agentRef` for this turn, expiring when the
  turn ends. The broker route derives identity **from the token**, not from
  whatever the request body claims, and rejects any body whose claimed identity
  disagrees with the token's binding.
- **Residual risk, documented rather than hidden**: `handlePreToolUse` calls
  `verifyAndConsume` against `approvalNonce`, so a forged request from inside the
  same sandbox could still burn its own run's single-use approval nonce early.
  Per-run token binding limits the blast radius to self-denial (the sandbox can
  only sabotage its own turn, never another role's or tenant's) — acceptable, but
  real, and must stay documented rather than silently assumed away.
- Add an explicit request body size cap and a rate limit on this route; anything
  over either maps to deny, not to an unbounded retry or a crash.
- New secret naming, following the existing `secret://` convention exactly
  (`packages/sandbox-client/src/secretResolver.ts`'s pattern): the per-turn token
  itself is minted at runtime (not a static `secret://` value), but the mechanism
  used to seed the *initial* signing/verification key (if HMAC-based tokens are
  used) should follow the same shape, e.g. `secret://broker/token_signing_key` →
  `OIK_SECRET_BROKER_TOKEN_SIGNING_KEY`.

**Fail-closed, per ADR-001 R3** (10s deadline): the route applies a defensive
server-side bound consistent with `BrokerFailure`'s existing taxonomy
(`broker.timeout`, `broker.http_500`, `broker.malformed_response`), but the
*authoritative* deadline is the hook script's own client-side timeout (§3) — a
slow-but-eventually-successful server response still counts as a timeout from the
hook's perspective past 10s, matching every other broker caller in this codebase.

#### 3. Hook script — closing four fail-open paths (change 3)

The exit-code contract is exit 0 = allow, exit 2 = block, reason on stderr — but
Fable found four concrete ways the naive version of this fails **open**, not closed,
each of which must be closed explicitly:

1. **Only exit code 2 blocks; every other non-zero exit is a non-blocking error and
   the tool runs anyway.** An uncaught exception exits 1. A missing `node` binary in
   a broken image exits 127. An OOM kill exits 134. None of these are "2", so all of
   them silently ALLOW. Required: wrap the invocation as `node hook.js || exit 2`;
   set `process.exitCode = 2` at the very top of the script before anything else can
   throw; install `process.on('uncaughtException', ...)` and
   `process.on('unhandledRejection', ...)` handlers that call `process.exit(2)`
   explicitly rather than letting Node's default handler pick an exit code.
2. **Claude Code's own settings-level hook `timeout` (default 60s) is non-blocking
   on expiry — the tool runs if the hook itself times out at that layer.** The
   script's own internal 10-second `AbortController` deadline (ADR-001 R3) must
   fire and exit 2 well before the settings-level timeout could ever be reached;
   the settings `timeout` value itself must be configured *above* 10s, never below
   or equal to it, or the settings layer's own non-blocking timeout becomes the
   effective (fail-open) deadline instead of the script's fail-closed one.
3. **The hook's `matcher` must be absent, or match every tool** — not copied from
   `territory-firewall.js`'s `Edit|Write|MultiEdit|NotebookEdit`, which would leave
   Bash, MCP tools, Agent, and Skill completely ungoverned inside the sandbox.
4. **The sandbox is per-role and persists across turns (ADR-010) — a hook
   registered in ordinary project `.claude/settings.json` or `settings.local.json`
   is only snapshotted at CLI startup, protecting the *current* turn.** An agent
   that writes to that file in turn N (including setting `disableAllHooks: true`)
   silently governs turn N+1 with no hook at all. Required: register the hook in
   the **managed settings tier**
   (`/etc/claude-code/managed-settings.json` or the equivalent for the pinned CLI
   version), root-owned and baked into the sandbox image so the sandbox's own
   uid cannot write it, with `disableAllHooks: false` pinned there explicitly. The
   worker should additionally verify that file's digest before dispatching each
   turn, so an image or mount tampered with out-of-band is caught rather than
   silently trusted.

Beyond the four fail-open fixes: also require HTTP 200 + JSON content-type +
`decision === "allow"` (exact match, not merely truthy) before exiting 0; emit the
`hookSpecificOutput` JSON on stdout alongside exit 2 for a deny (per the resolved
response schema in Context); deny outright if the hook's own `permission_mode`
field is one of CLAUDE.md's banned modes (a belt-and-braces local check, cheap and
independent of the network round trip); and verify the broker's JSON response
echoes back the same `toolUseId` the request carried, rejecting (deny) any
mismatch as a defensive integrity check on the round trip itself.

The `runId`/`roleId`/`tenantId`/`agentRef` values needed to build a
`PreToolUseRequest` do **not** come from the hook's own stdin payload (which only
carries `tool_name`/`tool_input`/`tool_use_id`/`session_id`/etc, never governance
identity) and must not be *inferred* by the script — that would be exactly the
"caller-supplied prose" ADR-004 already rejects for approval cards. They arrive as
**explicit environment variables** injected at `runCommand` invocation time, the
same discipline already established for `EXECD_ACCESS_TOKEN` and TASK-153's "no
host env, only explicitly-passed values" guarantee — the worker is the only party
that knows the real values for this turn.

#### 4. What Path A does not preserve, and what must be rebuilt to compensate (change 4)

Path A only rebuilds ADR-001's L1 (the PreToolUse hook itself). This is a real,
material regression versus how governance works today, and must be tracked
explicitly rather than left implicit:

- **L2** (deny rules / `dontAsk` mode): whoever implements this must verify which
  CLI flags on the pinned `claude` version reproduce the equivalent scoped
  `allowedTools`/`dontAsk` behavior, and confirm they exist in that exact version.
- **L3** (`canUseTool` as the last-line runtime defense): a bare CLI subprocess has
  no `canUseTool` callback at all. This is an explicit, permanent deviation from
  ADR-001's four-layer model for the sandboxed path — record what (if anything)
  covers the F5 failure class ADR-001 defines, or record honestly that nothing
  does yet.
- **R4 / PostToolUse** (completion evidence for the audit record): the design above
  only covers the pre-execution decision. A second command hook, or a second route
  on the same broker listener, is needed for `PostToolUse` — otherwise every audit
  record for a sandboxed run is missing its post-condition half.
- **Park on fail-closed / `approval_pending`**: today `withPark` parks
  client-side (in the same process the SDK's `query()` runs in). The broker route
  knows the real `runId` for this request, so parking should happen **server-side**
  in the new route's handler, not be left to the sandboxed hook script (which has
  no reasonable way to reach the worker's own run-lifecycle state).
- **CAN-05** (subagent attribution): derive `agentRef.isSubagent` from the
  resolved `agent_id` hook field (present only for subagent-fired hooks, per the
  Context section above), not assumed false.
- Whoever implements this should explicitly list which of the existing CAN-01…CAN-08
  canary suite need a sandboxed-path variant, rather than assuming the host-path
  canaries already cover it.

### Consequences

- **A genuinely new trust boundary and attack-surface class**, now correctly scoped
  by change 2's per-turn token binding rather than a single static shared secret —
  but still real: anyone who can reach the broker port over Tailscale during an
  active turn, holding that turn's token, can request decisions for that specific
  run/role/tenant (never another one, per the binding). Still a materially larger
  surface than today's zero-network in-process call. This is exactly the surface
  TASK-170's own Description flagged, and what TASK-185's iptables work sits
  beneath as defense in depth.
- **First real network-latency exposure for the broker decision path.** Every
  prior caller was in-process (sub-millisecond). TASK-170's own AC to "investigate
  real latency... report actual numbers, don't assume" now applies to this hop
  specifically, not just sandbox resolve/create.
- **`createInProcessBrokerPort` is unaffected and remains correct** for every
  non-sandboxed run — this ADR adds a second implementation, it does not
  deprecate or change the first.
- **A material governance regression versus the host-executed path (§4), tracked
  explicitly rather than silently accepted** — L2/L3/PostToolUse/park/CAN-05 all
  need their own rebuilt equivalent or an honestly-recorded gap, not an assumption
  they still work because L1 does.
- **Pre-existing type-duplication** (`compose.ts`'s hand-copied
  `BrokerDecisionRequest`/`BrokerDecisionResponse`) should be fixed by importing
  the real `packages/broker` types directly when this route is built, rather than
  adding a third hand-copied shape alongside it.

## Resolution — for whoever implements TASK-170 against this ADR

1. A new task (or TASK-170's own re-scoped territory) adding
   `POST /v1/broker/pretooluse` on its own listener/port, with per-turn
   token-bound auth, to `services/control-api` — protected-adjacent (calls into
   `packages/broker`), same different-model review discipline as the rest of this
   wave.
2. The standalone hook script (fail-closed per §3's four fixes, registered in the
   managed-settings tier per §3.4, exit-code and stdout-JSON contract verified
   against the pinned CLI version's real, current behavior — not assumed from this
   ADR's sketch).
3. TASK-170 itself: wire the sandbox-backed path to mint and inject the per-turn
   token plus `runId`/`roleId`/`tenantId`/broker-URL env values into the
   `/command` call, invoke `claude -p` as the entrypoint, rebuild or explicitly
   document the §4 gaps, and prove the §Liveness assertion (removing the hook
   registration must make an otherwise-identical undeclared tool call succeed
   instead of being denied, mirroring TASK-194's liveness proof) actually fails
   when the hook is removed.
4. Separately, and not blocking TASK-170: a follow-up spike on Path B, with either
   more time for live WebSocket protocol debugging against
   `.../session/{id}/ws` (the handshake completes; every message attempted so far
   closes with code 1008) or direct access to execd's server source, since Path B
   would eliminate nearly all of §1–§4's new surface if it can be made to work.

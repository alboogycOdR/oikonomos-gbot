# ADR-015 adversarial review — Fable 5.1, 2026-09-06

**Subject:** `docs/decisions/ADR-015-sandboxed-broker-enforcement.md` at commit `54c6745`
**Reviewer:** Claude Fable 5.1 (different model from the author, Sonnet 5 — satisfies CLAUDE.md's different-model requirement for `docs/decisions/**`)
**Requested by:** the human, on ORCH's behalf
**Verdict:** **Accept-with-changes.** All six changes below are required. Change 1 is a decision gate that may flip the primary path.

Evidence for every claim below was read directly from this repo or from the installed
Agent SDK (`@anthropic-ai/claude-agent-sdk` 0.3.233, `sdk.d.ts`) and the installed CLI
(`claude` 2.1.263). Nothing is taken from the ADR's own summary.

---

## Answers to the six review questions

### Q1 — Is the core mechanism sound?

Yes, with the fail-open fixes in change 3. But the ADR's stated *reason* the mechanism
is needed is factually wrong, and the ADR must be corrected before it is accepted.

Context item 1 says enforcement works today because `query()` and the broker "run in the
same OS process". They do not. The Agent SDK's `query()` spawns the `claude` CLI as a
child process over a stdio JSON transport (`ProcessTransport`), and every L1 hook
decision already crosses that process boundary as a `hook_callback` control request
that the worker process answers. Only the broker *port* behind the hook is in-process.
Cross-process hook enforcement is therefore not new to this project — it is what runs on
every turn today. TASK-170 changes *where the child process lives*, not whether a hook
can cross a process boundary.

### Q2 — Was the alternative rejected too quickly?

Yes, and for the wrong reason. The installed SDK exposes a documented extension point
for exactly this case:

```
// sdk.d.ts ~line 2110
/**
 * Custom function to spawn the Claude Code process.
 * Use this to run Claude Code in VMs, containers, or remote environments.
 * ...
 *   return myVMProcess; // Must satisfy SpawnedProcess interface
 */
spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess;
```

`SpawnedProcess` (sdk.d.ts ~line 7559) is just `stdin`, `stdout`, `exitCode`, `killed`,
`kill()`, and `exit`/`error` events. This is not reverse-engineering internals.

| Path | New trust boundary | ADR-001 layers preserved | Blocker |
|---|---|---|---|
| **A** — command hook + HTTP broker (ADR as written) | Yes, plus a credential inside the sandbox | L1 only unless extended (change 4) | None known |
| **B** — `spawnClaudeCodeProcess` over execd stdio | No | L1, L2, L3, PostToolUse, park, approval nonces, all CAN tests, byte-for-byte | Bidirectional transport spike |

Path B's real cost is transport: execd's `/command` is SSE (stdout-only, no stdin), so
it would need `/pty/{id}/ws` or `/session` plus a small raw-mode stdin bridge, and the
sandbox must hold a websocket to the worker for the turn. That is a one-day spike, not a
research project. Path B puts no broker token or run identity inside the sandbox and
opens no new network-reachable broker endpoint — it eliminates most of changes 2–5.

### Q3 — Is the auth boundary sufficient?

A separate token is necessary but not sufficient. See change 2 (identity binding) and
change 5 (listener separation). Mounting on `control-api` is acceptable only if the
route gets its own port.

### Q4 — Does the stdin-schema gap block?

No — it is resolved, from this repo's own `node_modules`. The SDK's typed hook input is
the same JSON the CLI pipes to command hooks:

```
// sdk.d.ts lines 164–185 (BaseHookInput) and 2327–2332 (PreToolUseHookInput)
session_id, transcript_path, cwd, prompt_id?, permission_mode?, agent_id?, agent_type?,
hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id
```

`packages/harness-factory/src/index.ts` `adaptL1` already reads `hook_event_name`,
`tool_name`, `tool_use_id`, `tool_input`. `agent_id` is documented as present only when
the hook fires inside a subagent — that is the CAN-05 attribution signal.

There is also a richer response than the exit code: exit 0 plus stdout JSON

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow|deny|ask",
 "permissionDecisionReason":"...","updatedInput":{...}}}
```

The ADR needs it: `mapBrokerDecision` already supports `updatedInput`, which a bare exit
code cannot carry.

### Q5 — Any silent fail-open?

Four, as written. See change 3.

### Q6 — Anything else?

Changes 4 and 5.

---

## Required changes

### 1. Correct the premise and re-decide the primary path (decision gate)

- Rewrite Context item 1: hooks already cross a process boundary via the SDK's stdio
  control protocol; only the broker port is in-process.
- Replace the rejection paragraph with an honest comparison against
  `spawnClaudeCodeProcess` (table above).
- Gate the decision on a time-boxed spike (≤1 day): can a `SpawnedProcess` be built over
  execd's pty websocket or session endpoint with raw stdio and clean exit propagation?
  If yes → B is primary, A is the fallback. If no → record the concrete failure and keep A.

### 2. Bind identity to the credential, not the request body

As designed, the agent's Bash tool can read `BROKER_ACCESS_TOKEN` and the run identity
from its own environment (they are injected as env vars for the hook, and Bash inherits
the same env), then `curl` the endpoint claiming any `roleId`/`tenantId`. The route
cannot distinguish that request from the hook's.

- Replace the static shared token with a **per-turn token** minted by the worker, bound
  server-side to `runId`, `roleId`, `tenantId`, `agentRef`, expiring when the turn ends.
- The route derives identity from the token and rejects any body that disagrees.
- Nonce consequence: `handlePreToolUse` calls `verifyAndConsume` on `approvalNonce`, so
  a spoofed request can burn a single-use approval. Per-run binding limits this to
  self-denial (acceptable). Document it.
- Add a rate limit and an explicit body-size cap; over-cap maps to deny.

### 3. Close the fail-open paths in the hook contract

1. **Only exit code 2 blocks.** Any other non-zero exit is a *non-blocking error* and the
   tool runs. Uncaught Node exception → 1. Missing `node` binary → 127. OOM kill → 134.
   Required: register the command as `node hook.js || exit 2`; set `process.exitCode = 2`
   at the top of the script; install `uncaughtException` and `unhandledRejection`
   handlers that `process.exit(2)`.
2. **Settings-level hook `timeout` (default 60 s) is non-blocking on expiry** — the tool
   runs. The 10 s deadline must live inside the script (AbortController); the settings
   `timeout` must be set *above* it, never below.
3. **Matcher must be absent or match everything.** Copying `territory-firewall`'s
   `Edit|Write|MultiEdit|NotebookEdit` matcher leaves Bash, MCP tools, Agent, Skill
   ungoverned.
4. **Persistent sandbox + agent-writable settings.** The sandbox is per-role and persists
   across turns; hooks are snapshotted at CLI startup, which protects the *current* turn
   only. A `.claude/settings.json` or `settings.local.json` the agent writes in turn N
   (including `disableAllHooks: true`) governs turn N+1. Required: register the hook in
   the **managed settings tier** (`/etc/claude-code/managed-settings.json`, root-owned,
   baked into the image, agent uid cannot write), pin `disableAllHooks: false` there,
   and have the worker verify that file's digest before each turn.
5. Also: emit the JSON deny on stdout alongside exit 2; deny if `permission_mode` is a
   banned mode (L4 belt-and-braces); verify the response echoes the request's
   `toolUseId`; require HTTP 200 + JSON content-type + `decision === "allow"` for exit 0.

### 4. Account for the ADR-001 layers the sandbox path loses

The ADR rebuilds L1 only. Specify:

- **L2**: the CLI flags reproducing `dontAsk` + scoped `allowedTools`, verified to exist
  in the pinned CLI version.
- **L3**: a bare CLI has no `canUseTool`. Record this as an explicit deviation from
  ADR-001's four layers and state what covers the F5 class.
- **R4 / PostToolUse**: a second command hook + route for completion evidence, or the
  audit record loses its post-condition half.
- **Park**: who parks on fail-closed / `approval_pending`? Today `withPark` does it
  client-side; the route knows `runId`, so park server-side.
- **CAN-05**: derive `agentRef.isSubagent` from the `agent_id` hook field.
- List which of CAN-01…CAN-08 need a sandboxed variant.

### 5. Give the route its own listener

iptables / Tailscale ACLs filter by port, not by path. On the shared listener the
sandbox can reach every management route one bearer away. Required: bind a second
Fastify instance to a separate port (same process is fine), excluded from the global
auth `preHandler` *by construction* rather than by allowlist. Two tests:
`CONTROL_API_TOKEN` is rejected on the broker route; the broker token is rejected on
every other route.

### 6. Close the open question and pin the CLI

Replace the "Open question" block with the field list from Q4. Pin the CLI version in
the sandbox image so ADR-001's monthly re-verification job covers the hook contract.

---

## Re-review

Reviewer will re-read the ADR diff once the changes are applied. If the change-1 spike
lands on path B, changes 2–5 collapse to the transport bridge plus the managed-settings
hardening from change 3.4.

# Problem Statement: OpenSandbox has no remote command-execution API — OIK-043's design assumption is wrong

**Date:** 2026-09-05
**Author:** ORCH (Claude), for review by senior architect
**Status:** RESOLVED 2026-09-05 — see "Resolution" section at the end. Original problem statement retained below unchanged.
**Related:** `docs/decisions/ADR-006-addendum-b-opensandbox-adoption.md`; PLAN.md TASK-142 (done), TASK-169 (blocked), TASK-170/171 (ungrounded pending this decision)

---

## Context

ADR-006 (2026-08-16) adopted OpenSandbox as the isolation runtime for agent execution (OIK-042), superseding hand-built Docker isolation. It's deployed and live — `opensandbox-server` v0.2.2 running on our host, reachable only over Tailscale, confirmed operational. TASK-142 built `packages/sandbox-client`, a thin typed client proving connectivity and basic lifecycle control (`createSandbox`, `destroySandbox`) against the real server.

The next planned step (OIK-043) was to route real chat/task execution through an OpenSandbox sandbox instead of the current mechanism — each chat turn spawning a fresh local OS-level temp directory as an isolated `cwd` for the agent process, with a scoped, empty environment (no inherited secrets). The assumed integration shape, going in, was: create a sandbox, **remote-exec the agent's command inside it, capture stdout/stderr/exit code, tear the sandbox down** — essentially treating OpenSandbox as a remote command-execution service, one sandbox per chat turn.

## What we found, empirically, against the live server — not the docs, the actual deployed API contract

We fetched and fully enumerated the live server's own OpenAPI 3.1 spec (`GET /openapi.json`, self-reported title "OpenSandbox Lifecycle API" v0.1.0, server build v0.2.2). Its complete path surface is:

```
/health
/sandboxes                                  (POST create, GET list)
/sandboxes/{sandbox_id}                     (GET, DELETE)
/sandboxes/{sandbox_id}/pause
/sandboxes/{sandbox_id}/resume
/sandboxes/{sandbox_id}/renew-expiration
/sandboxes/{sandbox_id}/metadata
/sandboxes/{sandbox_id}/diagnostics/{events,inspect,logs,summary}
/sandboxes/{sandbox_id}/endpoints/{port}
/sandboxes/{sandbox_id}/proxy/{port}
/sandboxes/{sandbox_id}/proxy/{port}/{full_path}
/sandboxes/{sandbox_id}/snapshots
/snapshots, /snapshots/{snapshot_id}
/pools, /pools/{pool_name}
/v1/metrics/events
```

We searched every path, operation ID, summary, description, and component schema name in the entire spec for anything shaped like exec, command, shell, terminal, or process. **There is nothing.** The only occurrences of the word "execution" describe sandbox *lifecycle* state ("terminates sandbox execution," "pause execution while retaining state") — not command invocation.

Critically, the `CreateSandboxRequest` schema (the body of `POST /sandboxes`) contains an `entrypoint` field:

> *"The command to execute as the sandbox's entry process. Required when `image` is provided. Optional when `snapshotId` is provided; the server defaults to `["tail", "-f", "/dev/null"]` when omitted."*

This is the load-bearing detail. **OpenSandbox's actual model is: you specify a container image and a single long-lived entry command at creation time. That process runs for the sandbox's lifetime. You do not send it further commands.** The `endpoints/{port}` and `proxy/{port}` API exists specifically to let a caller reach a *network service* the entry process itself exposes (an HTTP server, a WebSocket, whatever the image's entrypoint binds to a port) — not to issue ad hoc shell commands into an idle container.

## Why the original design breaks

Our assumed pattern — "create sandbox → exec a fresh command for this one chat turn → destroy" — has no corresponding API call. There is no `POST /sandboxes/{id}/exec`, no attach, no shell-session endpoint of any kind, in this server version.

## What we believe the real integration model has to be, pending confirmation

The sandbox's `entrypoint` should itself be a long-lived process — most plausibly, a small HTTP or RPC server (our own code) that the chat driver starts once per sandbox lifetime (or once per some coarser unit — a role, a routine, a session — not per chat turn) and then talks to over `proxy/{port}`, sending it individual work items (a tool call, a prompt turn) as requests over that exposed port, rather than creating a fresh sandbox and execing a fresh process per turn.

## Open questions for design, in priority order

1. **Confirm the hypothesis directly** — build the smallest possible sandbox whose `entrypoint` is a trivial HTTP echo server, prove we can create it, reach it via `proxy/{port}`, and get a response, before designing anything further on top of an assumption.
2. **Granularity of sandbox lifetime.** If a sandbox holds one long-lived process reached via proxy, what's the actual unit of isolation — one sandbox per chat run (create/destroy per turn, but now hosting a *server* not a *one-shot command*, meaning our own code needs to implement request routing inside that server), one per thread/conversation, one per bot/role, or one per tenant? This is a real latency/cost trade-off: OpenSandbox sandbox creation is not instant, and if it's too slow for per-turn use, the whole model shifts toward longer-lived sandboxes with our own multiplexing inside them.
3. **What does the "entry process" actually need to be?** Does the Claude Agent SDK (or our harness-factory abstraction over it) support running as a server that accepts turns over a socket/HTTP, or does it fundamentally expect to be invoked as a one-shot CLI process per turn? If the latter, we may need a thin wrapper process as the real entrypoint, whose job is purely "listen on a port, spawn/manage the actual SDK subprocess per request, relay stdout back over the proxy."
4. **Does a newer OpenSandbox release add exec support?** We pinned and are running v0.2.2 per ADR-006's own R14 ("pin a specific release, do not track latest"). It's worth explicitly checking the project's upstream changelog/roadmap for whether a command-execution API is planned or already shipped in a later version we haven't pulled in, since that would materially simplify everything above by letting us go back to the original per-turn-exec design.
5. **Security implications of the proxy model.** The current design (TASK-153/154, already shipped) isolates each chat run via a scoped empty environment and a disposable local temp directory, and explicitly closed an MCP-config leak and a workspace-isolation leak this way. Whatever the real sandbox-based replacement looks like, it must preserve those same guarantees — no secret inheritance, no cross-run leakage — and the proxy-based network path is a new attack surface class (an exposed port reachable from the host) that didn't exist in the local-temp-dir model and needs its own threat model, not an assumed one.

## Net ask

We need an architectural decision on the real integration shape (a long-lived proxied entrypoint process, not per-turn exec) before OIK-043 (routing real chat execution through OpenSandbox) can be scoped as an actual task, and before the mobile "live agent monitor view" feature — which depends entirely on OIK-043 existing — can be designed at all.

**Recommendation:** authorize a narrow, cheap spike (item 1 above) to empirically prove the proxy-reachable-entrypoint pattern works exactly as the schema implies, before committing engineering time to the larger design.

---

## Resolution (2026-09-05, ORCH research session) — the exec API exists; it lives in the sandbox, not on the lifecycle server

**Status:** resolved as a design; TASK-169 can be re-scoped. No new dependency, no upstream feature to wait for.

### The finding

The blocker is a misreading of OpenSandbox's split architecture, not a missing capability. OpenSandbox has **two** HTTP APIs, and we only enumerated one:

| API | Where it runs | Auth | What it does |
|---|---|---|---|
| **Lifecycle API** (`opensandbox/server`, what `/openapi.json` on `:8080` describes) | Our Tailscale-bound server container | `OPEN-SANDBOX-API-KEY` | create / pause / resume / delete / snapshots / pools / **endpoint resolution + proxy** |
| **execd API** (`opensandbox/execd`, a Go daemon) | **Inside every sandbox**, port `44772` | optional `EXECD_ACCESS_TOKEN` | `POST /command` (SSE-streamed stdout/stderr/exit), `/session` (persistent bash), `/files`, `/directories`, `/pty/{id}/ws`, `/v1/isolated/session`, `/metrics`, `/ping` |

The lifecycle server *injects* execd into every sandbox it creates — it stages the execd binary from `[runtime].execd_image` plus a `bootstrap.sh` launcher around the user's `entrypoint`. **Our own deployment already does this**: `infra/sandbox/README.md` §4 pins `execd_image = "opensandbox/execd:…"`, and the §6 verification log shows every sandbox publishing **two** ports — `…->8080/tcp` and `…->44772/tcp`. The second one is execd. It has been running in every sandbox we ever created; nothing ever called it.

The official SDKs (`@alibaba-group/opensandbox` for TS, `opensandbox` for Python) do exactly this: `Sandbox.create()` → `GET /v1/sandboxes/{id}/endpoints/44772` → talk to execd at the returned `endpoint` (optionally via the lifecycle server's `proxy/{port}` when `use_server_proxy=true`). `sandbox.commands.run(cmd)` is `POST {execd}/command` consuming SSE. Upstream evidence: `docs/architecture.md`, `docs/components/execd.md`, `components/execd/pkg/web/router.go` (route table), `sdks/sandbox/javascript/src/core/constants.ts` (`DEFAULT_EXECD_PORT = 44772`), `sdks/sandbox/javascript/src/adapters/sandboxesAdapter.ts` (`fetchSandboxEndpoint`). Upstream checkout at commit `82143b6` (2026-09-04).

So the original per-turn shape — create sandbox → run command → capture stdout/stderr/exit → destroy — **is** supported, exactly as OIK-043 assumed. The `entrypoint` field is the container's PID-1 workload (`tail -f /dev/null` is the documented idle default), and execd runs alongside it. There is no need to write our own in-sandbox server.

### Answers to the five open questions

1. **Confirm the hypothesis** — the hypothesis ("we must run our own long-lived HTTP server as the entrypoint") is *wrong*; the correct spike is smaller: create a sandbox with the default idle entrypoint, `GET /v1/sandboxes/{id}/endpoints/44772`, `GET {endpoint}/ping`, then `POST {endpoint}/command` with `echo hello`. Expected: SSE stream with stdout `hello`, exit 0. Half a day, not a design.
2. **Granularity** — decoupled from the exec question now. Per-turn create/destroy works; but a persistent-office-computer model (ADR-010) wants a **long-lived sandbox per role/tenant** with execd `/session` (persistent bash, cwd + env persist) or per-turn `/command` inside it. Recommendation: **one sandbox per role, hibernated via `pause` when idle**, per-turn `/command` calls — this is the Grok Bot model and what ADR-010 asked for. Create-per-turn stays available for Tier-3/4 isolated runs (OIK-045c).
3. **Entry process** — no wrapper needed. The Claude Agent SDK / `claude -p` runs as an ordinary command via `POST /command` (upstream ships `examples/claude-code/` doing exactly this on the `opensandbox/code-interpreter` image, with `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL` as env). Our `chatRunDriver` today spawns the harness as a subprocess with a scoped cwd/env; the sandbox version spawns it via execd with the same scoped env passed in the request body — same shape, different transport.
4. **Newer release** — not needed. execd's `/command` has existed since 1.0.x; our pinned server v0.2.2 already exposes `endpoints/{port}` and `proxy/{port}`. R14 pin stands. **One thing to verify on the host:** the README records execd `v1.0.22` but upstream release notes top out at `1.0.12` — check `docker images` on clawsrv and correct whichever is the typo.
5. **Security of the proxy model** — this is the real work, and it is now well-defined:
   - **Prefer `use_server_proxy=true`.** Then all execd traffic goes *through* the lifecycle server on `100.78.70.2:8080` (Tailscale-only, API-key-authenticated) instead of the sandbox's directly-published `30000–30999` port. That makes the `infra/sandbox/README.md` §7.1 exposure (sandbox ports publish on `0.0.0.0`, shielded only by the Hetzner cloud firewall) *not load-bearing for our own traffic* — but the ports are still open to anyone who can reach them, so **the deferred `DOCKER-USER` iptables remedy in §7.1 fires now**: its stated trigger was "before the first real workload runs in a sandbox," which is TASK-170.
   - **Set `EXECD_ACCESS_TOKEN`** per sandbox (pass it in the create request `env`; execd's launcher strips its own credential vars from every user-code process, so the token is not visible to the agent). Without it, execd is unauthenticated to anyone who reaches port 44772 — i.e. any process able to hit the 30xxx band could run commands in our sandboxes. Resolve the token via the existing `secret://` resolver convention; never in logs (NN#4).
   - **Env scoping is preserved**, and strengthened: the `/command` body carries `env`/`cwd` explicitly, so TASK-153's "no inherited secrets" guarantee is enforced by construction — the sandbox has no host env at all. TASK-154's MCP-config-leak fix maps to "the image has no `~/.claude.json`/`.mcp.json` and the loopback MCP bridge (TASK-079) is the only tool path."
   - **Tool calls still go through the broker.** Executing inside a sandbox changes *where the harness runs*, not *who gates its tools*. The `PreToolUse` hook remains the enforcement point (ADR-001); the harness inside the sandbox reaches the broker over the loopback/Tailscale MCP bridge exactly as the local-subprocess harness does today. This must be an explicit acceptance criterion on TASK-170, with a liveness assertion (a tool call from inside the sandbox that the broker denies must actually be denied — evidence emitted by the hook, not config presence).
   - **Hardening floor:** `docs/components/execd.md` documents an optional isolation config (cap-drop, `no_new_privs`, seccomp, Landlock) applied to every `/command` process, plus `/v1/isolated/session` (bubblewrap namespaces). OIK-045c should use these before reaching for gVisor/Kata.

### Build choice: SDK vs. own client

Two options for `packages/sandbox-client`:

- **(a) Adopt `@alibaba-group/opensandbox` 0.1.11** (Apache-2.0, Node ≥ 20, deps: `openapi-fetch`, `undici`; published 2026-07-24) and wrap it. Pros: SSE parsing, readiness polling, session/files/PTY already done and tested upstream. Cons: young API (0.1.x), a third runtime dependency behind the isolation boundary, R14 drift-watch must now cover the SDK too, and its execd client's auth-header story needs checking against our token requirement.
- **(b) Extend our hand-rolled client** with `getEndpoint(port)`, `ping()`, and `runCommand()` (SSE consumer) against execd's documented routes. Pros: ~300 lines, no new runtime dep, keeps the NN#4 secret-hygiene tests we already have, matches TASK-142's discipline. Cons: we own SSE parsing and any execd wire-format drift.

**Recommendation: (b) for TASK-169, keeping the SDK's TypeScript types (`models/execd.ts`) as the reference contract.** The primitive we need is small and security-sensitive; owning it keeps the review surface inside a package we already adversarially review. Revisit (a) if/when we need PTY (the live-agent view, TASK-171 — execd's `/pty/{id}/ws?mode=viewer` is precisely a read-only live terminal) or files APIs at scale.

### Consequences for PLAN.md (for the next ORCH planning session — not applied here)

- **TASK-169** — unblock; re-scope to: `getEndpoint`, `ping`, `runCommand` (SSE → `{stdout, stderr, exitCode}`), `EXECD_ACCESS_TOKEN` passed at create and sent on every execd request, `use_server_proxy=true` by default, unit tests on fake transport, gated live test. Keep "do not touch services/worker".
- **TASK-170** — now groundable. Add ACs: broker hook still gates every tool call from inside the sandbox (with liveness assertion); no host env reaches the sandbox; sandbox-per-role with `pause` on idle (ADR-010) rather than per-turn create; `infra/sandbox/README.md` §7.1 iptables remedy applied and verified by observed refusal *before* merge (its own stated trigger).
- **TASK-171** — the live-agent view has a real substrate: execd PTY viewer mode (`/pty/{id}/ws?mode=viewer&since=0`) gives replay + live output without granting write access. Design it against that.
- **infra/sandbox/README.md** — record the execd port/API, the token decision, and resolve the v1.0.22-vs-1.0.12 discrepancy.
- **OIK-045c** — note execd's isolation config + isolated sessions as the first rung before Kata/Firecracker.

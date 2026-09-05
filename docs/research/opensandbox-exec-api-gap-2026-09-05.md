# Problem Statement: OpenSandbox has no remote command-execution API — OIK-043's design assumption is wrong

**Date:** 2026-09-05
**Author:** ORCH (Claude), for review by senior architect
**Status:** open — needs an architectural decision before OIK-043 (and, transitively, the mobile live-agent/monitor view) can be scoped
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

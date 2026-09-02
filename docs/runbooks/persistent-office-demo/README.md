# Runbook — persistent-office vertical-slice demo (TASK-060)

Demonstrates, live, on real infrastructure: a task in via Telegram, a governed
run, an **enforced-floor** action parking for real human approval, a real
phone tap resolving it, a real nonce-bound single-use consumption completing
the action, a separately-**denied** D3 sealed-secret attempt, and an
**autonomous** action executing without a card — the two halves ADR-010 §5.4
requires to actually demonstrate the persistent-office-computer pivot (not
just one).

## What's real vs. scripted

Real: Postgres (`roles`, `tasks`, `runs`, `approvals`, `audit_events`), the
broker's L1 decision path (`packages/broker`), the six-rank enforcement
resolver (`packages/policy`), the D3 sealed-secret guard
(`packages/broker/secretPathGuard`, TASK-088/093), nonce-bound single-use
approval issue/consume (`packages/approvals`), `control-api` as a real
running HTTP server, and a real Telegram bot round trip to the operator's
phone.

Scripted (disclosed, matching the TASK-054/055 demo precedent): the *tool
calls* a model would normally choose are presented deterministically by
`run-demo.mjs` rather than by a live LLM conversation, so the enforcement
and persistence proof is 100% real while the "what to do next" decision is
scripted. The "local execution" action, once approved, is logged as
approved and **not actually executed on this machine** — approval unlocks
the capability; it does not obligate the script to run an arbitrary
command, and doing so for real would be an unnecessary risk for a demo.

## How to run it

```
export DATABASE_URL=...   # local Postgres, e.g. oikonomos-postgres-local
export TELEGRAM_BOT_TOKEN=...
node docs/runbooks/persistent-office-demo/run-demo.mjs
```

1. The script builds nothing itself — run `pnpm -r build` first if any
   package changed.
2. It starts `control-api` as a real background process on port 3099,
   waits for `/openapi.json` to answer, then prints "control-api is up."
3. It then waits for **any message** from you to the bot in Telegram — that
   message's `chat.id` becomes the demo's trigger and destination.
4. Two governed runs execute against the real broker (see "What happened,"
   below).
5. When the enforced-floor action parks, it sends you a real inline-keyboard
   Approve/Reject card. Tap one.
6. It prints a JSON summary at the end and shuts `control-api` down cleanly.

**Stop / reverse:** Ctrl+C at any point kills the script; the child
`control-api` process is cleaned up in the same step in the happy path, or
can be killed by PID otherwise (`Get-CimInstance Win32_Process | Where
CommandLine -like '*control-api*'` on Windows). No lasting state is created
outside the `office-demo` tenant's rows, which nothing else in the system
reads.

## What happened (real run, 2026-09-02)

Trigger: an operator message `"Hi"` to `@GithubBuild_bot`, chat `880001908`.

**1. Autonomous action — no card.**
`email.list` (Tier `T0_observe`, no enforced-floor classification) executed
immediately. Real audit row:

```
run_id   17d8d07a-e847-423a-aa89-714b435935aa
actor    agent:office-demo
event    policy.decision
capability email.list   tier T0_observe   verdict allow
```

**2. Enforced-floor action — real park, real phone tap, real completion.**
`office.local_execute` is declared with `enforcedActionClasses:
["E3_local_machine_execution"]` — per ADR-010 §6, execution on the user's
local machine is enforced-floor, not autonomous-by-default, regardless of
tier or grant. The broker parked it and issued a **real** approval:

```
approval_id   67620e80-407a-4ecd-b4de-dd9a281cb07e
capability_id office.local_execute
status        granted -> consumed
decided_by    telegram:user:880001908
requested_at  2026-09-02 05:57:11.032Z
decided_at    2026-09-02 05:57:17.804Z   (6.8s after the card was sent)
consumed_at   2026-09-02 05:59:29.729Z
```

The Telegram card read *"Approval needed (enforced floor E3 — local machine
execution): destination: local-shell / toolName: office.local_execute /
input: {command: "echo demo", target: "local-shell"}"* — the operator tapped
**Approve**. `control-api`'s `POST /approvals/:nonce` decided it for real
(`decided: true`); a follow-up re-attempt of the same tool call, presenting
the granted nonce, then consumed it — `verifyAndConsume`'s row-count-1
atomic guarantee fired for real, moving the approval to `status: consumed`.
This is the exact "approve on phone → action completes" loop TASK-060's
acceptance criteria require, proven with a real nonce a real human decided.

**3. Denied — no card offered.**
A second, independent governed run (per ADR-010 §3.4: no checkpoint/resume,
an interrupted run ends and the next attempt starts fresh) attempted to
read `/oikonomos-secrets/cookie-store`. The D3 guard denied it
unconditionally, before capability lookup ever ran, and never offered an
approval:

```
run_id   4fc46471-989c-4e99-804f-35e37918fdbd
actor    agent:office-demo
event    policy.decision
verdict  deny
reason   secret_path.sealed
```

Note the payload carries no `capability`/`tier`/path material at all — by
design (N4): a D3 denial's audit trail is deliberately target-free.

## Real integration issues found and fixed while building this

None of these are shipped-code defects — they're all in `run-demo.mjs`
itself, a new integration script, not in previously-reviewed/merged
packages. Recorded here because they're the kind of thing the *next*
runbook author will hit too:

1. **`control-api`'s process entrypoint guard doesn't reliably match on
   Windows.** `services/control-api/src/index.ts` guards its `start()` call
   with `import.meta.url === file://${process.argv[1]}`, which compares a
   URL-encoded path against a raw OS path — backslash vs. forward-slash
   means it never matches on Windows. Fixed here by invoking
   `import(...).then(m => m.start())` explicitly via `node -e`, rather than
   changing the guard itself (out of this task's territory).
2. **`allowedTools` must use the scoped `Tool(*)` form** (ADR-001 R1/F2) —
   a bare capability name like `"email.list"` is rejected as an
   unscoped/ambiguous entry.
3. **`composeHarness`'s query function lives at `runtime.harness.query`**,
   not `runtime.query` — easy to get wrong reading the return type quickly.
4. **`RiskTier` values are an exact closed set**
   (`T0_observe`/`T1_draft`/`T2_internal`/`T3_external`/`T4_irreversible`).
   An invalid string (e.g. `"T2_write"`) fails `isCapability`/`isRoleGrant`
   silently from the caller's point of view — the broker denies with a
   generic `broker.malformed_response`/`broker.dependency_failure`, not a
   validation error naming the bad field. Worth a follow-up: a clearer
   error message here would have saved real debugging time.
5. **`approvals.capability_id` carries a real foreign key** to the
   `capabilities` table. A capability declared only in an in-memory
   `brokerDependencies.getCapability` (not persisted via
   `Database.upsertCapability`) passes L1 enforcement fine but fails at
   `issueApproval` time with a Postgres FK violation the moment the action
   actually needs to park. `run-demo.mjs` seeds both demo capabilities for
   real before running.
6. **A genuine naming inconsistency, found and NOT fixed here:**
   `packages/broker/src/secretPathGuard.ts` defines its D3 root as
   `/oikonomos-secrets` (hyphenated, no subdirectory); `services/workspace`'s
   own D3 root is `/oikonomos/secrets` (slash-separated). Both guards are
   internally correct and independently proven, but a caller matching one
   package's convention will silently miss the other's. Worth a small
   follow-up task to unify the constant into one shared source (e.g.
   `@oikonomos/shared`) rather than two package-local literals.

## Cleanup

The script's own `office-demo` tenant rows (roles, tasks, runs, approvals,
audit_events) are left in place as this run's evidence — they're isolated
to the `office-demo` tenant and read by nothing else in the system. Delete
them with:

```sql
DELETE FROM approvals WHERE tenant_id = 'office-demo';
DELETE FROM audit_events WHERE tenant_id = 'office-demo';
DELETE FROM runs WHERE tenant_id = 'office-demo';
DELETE FROM tasks WHERE role_id LIKE 'office-demo-%';
DELETE FROM roles WHERE tenant_id = 'office-demo';
DELETE FROM capabilities WHERE adapter = 'office-demo';
```

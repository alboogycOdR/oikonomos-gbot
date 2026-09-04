# Runbook — Platform-wide capability kill switch (OIK-112)

**Status:** live, proven end-to-end (TASK-140). **Owner:** ORCH (this doc is a protected path, `docs/**` — builders cannot edit it).

## What this is

Every tool call the broker mediates calls `dependencies.getCapability(toolName)` fresh, on every single decision (`packages/broker/src/index.ts`, `handlePreToolUse`) — there is no caching layer between a capability's `enabled` flag in Postgres and the next decision that depends on it. This means disabling a capability is a **live, immediate, same-process** operation: no service restart, no redeploy, no registry rebuild.

Two DB methods implement the switch itself (`packages/db/src/database.ts`, added TASK-140):

- `Database.setCapabilityEnabled(capabilityId, enabled)` — flips one capability, `UPDATE ... RETURNING`, no-op (returns `null`) if the capability doesn't exist.
- `Database.setAllCapabilitiesEnabled(enabled)` — flips every registered capability at once (the platform-wide emergency stop), returns the row count affected.

Proven live end-to-end (real Postgres, same process, same injected `BrokerDependencies` object, no restart) in `services/worker/src/killSwitchDrill.test.ts`:
1. A capability is enabled → a real `handlePreToolUse` call returns `allow`.
2. `setCapabilityEnabled(id, false)` is called.
3. The very next `handlePreToolUse` call, same dependencies, same process → returns `deny` (`reason: "capability.unregistered"`) — no restart, no new `CapabilityRegistry` construction.
4. Repeated for the platform-wide case (`setAllCapabilitiesEnabled(false)`) — every registered capability denies on the next call.

## When to use this

Pull the switch when a capability (or the whole platform) needs to stop being usable **right now** — a compromised credential, a runaway routine, a broker/policy incident, or any situation where waiting for a deploy is unacceptable.

## Procedure — disable one capability

```ts
import { Database } from "@oikonomos/db";

const db = new Database({ connectionString: process.env.DATABASE_URL! });
await db.setCapabilityEnabled("<capability_id>", false);
```

Equivalently, direct SQL (if you have DB access but not a Node REPL handy):

```sql
UPDATE capabilities SET enabled = false WHERE capability_id = '<capability_id>';
```

**Verify:** the next tool call using that capability's declared tool name will be denied by the broker with `reason: "capability.unregistered"`. No other step is required — this is not eventually consistent.

## Procedure — platform-wide emergency stop

```ts
await db.setAllCapabilitiesEnabled(false);
```

or:

```sql
UPDATE capabilities SET enabled = false;
```

This disables **every** registered capability immediately, including ones that were already disabled (the return value is a full inventory count, not just the number of rows that changed state — useful as an audit figure: "N capabilities were live at the moment the switch was pulled").

**Verify:** every subsequent tool call across every role is denied with `reason: "capability.unregistered"` until capabilities are selectively or fully re-enabled.

## Recovery — re-enabling after a drill or incident

Re-enable only what's actually safe to restore. Do not blanket-flip everything back on without review after a real incident:

```ts
await db.setCapabilityEnabled("<capability_id>", true);
```

For a full platform-wide restore after a drill (not after a real incident — a real incident should have its capabilities re-enabled one at a time, deliberately):

```ts
await db.setAllCapabilitiesEnabled(true);
```

## What this does NOT do

- It does not revoke already-issued approvals or kill an in-flight tool execution that has already passed its `pretooluse` check — it only blocks the *next* decision.
- It does not touch role grants (`role_grants` table) — a role's tier ceiling for a capability is a separate, orthogonal control.
- It is not a substitute for rotating a compromised credential — pulling the switch stops the *broker* from authorizing further use, it does not invalidate a token that a connector might still hold.

## Reference

- `packages/db/src/database.ts` — `setCapabilityEnabled`, `setAllCapabilitiesEnabled`
- `packages/broker/src/index.ts` line ~384 — the live per-decision `getCapability` read this switch relies on
- `services/worker/src/killSwitchDrill.test.ts` — the proof this procedure actually works, same-process, no restart
- `docs/architecture/OIKONOMOS_Master_Work_Breakdown_v1.0.md` — OIK-030 (capability-level kill switch), OIK-112 (this drill)

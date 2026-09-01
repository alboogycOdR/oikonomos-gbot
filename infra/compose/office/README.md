# The Office — durable per-tenant environment

`infra/compose/docker-compose.office.yml` plus this directory implement the
persistent office computer of `specs/OIKONOMOS_WBS_Addendum_F_v1.0.md` §2
(F1/F2/F3) and §4.3 (F11). One tenant (`basileia` today, per F1 — the
isolation boundary is the tenant, never the role) owns one long-lived
container pair:

- **office-model** — the container the agent/model process actually runs
  in. Mounts only the D1 workspace volume.
- **office-browser** — the non-model connector/browser service. Mounts the
  D1 workspace volume *and* the D3 secrets volume.

## Durability tiers (Addendum F §2.2)

| Tier | Contents | Survives rebuild? | Backing store |
|---|---|---|---|
| D0 — Record | tasks, runs, approvals, audit, roles, routines, memory | Yes | Postgres (outside the Office entirely) |
| D1 — Durable volume | `/oikonomos/workspace/**`, `/oikonomos/roles/<role_id>/**` | Yes | named volume `oikonomos-workspace`, mounted into both services |
| D2 — Replaceable | image layer, packages, `/tmp`, caches | **No** | each container's writable layer (not a named volume) |
| D3 — Sealed secret | browser profile, cookies, connector tokens, CLI credentials | Yes | named volume `oikonomos-secrets`, mounted **only** into office-browser |

D3 is not mounted into office-model at all — the path does not exist in that
container's filesystem namespace. That omission is layer 1 of N13 (§4.3 F11)
and the strongest control in this design; layers 2 (broker denial, TASK-088)
and 3 (audit event) back it up, but layer 1 is what makes the other two
unnecessary in the common case. Do not add a D3 mount to office-model for any
reason, "temporary" or otherwise — that is a direct N13 violation.

## Lifecycle verbs (Addendum F §2.3 F3)

All four scripts accept `OFFICE_PROJECT` (defaults to
`oikonomos-office-basileia`) to select the docker compose project/tenant
environment, and print which tiers they preserve and which they discard.

| Verb | Script | D0 | D1 | D2 | D3 |
|---|---|---|---|---|---|
| `provision` | `provision.sh` | untouched | created fresh | created fresh | created fresh |
| `rebuild` | `rebuild.sh` | untouched | preserved | **discarded** | preserved |
| `recover` | `recover.sh` | untouched | preserved | **discarded** | preserved |
| `restore` | `restore.sh` + `snapshot.sh` | untouched | **may be lost** (see below) | discarded | untouched |

There is **no checkpoint/resume** (probe Q3). Any run in flight against the
Office when `rebuild`, `recover`, or `restore` runs is cancelled, never
suspended; the caller records `run_status = 'cancelled'` with a failure note
naming the verb (D0, outside this directory's territory).

### `restore` — the only verb that can lose D1 writes

`restore.sh` reattaches the **last synced snapshot** taken by `snapshot.sh`
(Grok Bot's "Reset"). Anything written to `oikonomos-workspace` (D1) *after*
that snapshot was taken is permanently lost — this is the one lifecycle verb
with that property, which is exactly why Addendum F §2.3 F3 requires it to be
the only one gated behind an approval. `restore.sh` prints this warning
explicitly every time it runs; approval enforcement itself is the broker's
job (ADR-004/ADR-007 nonce-bound, single-use), not this script's.

## Durability canary (mandatory liveness assertion, ADR-005)

`durability-canary.sh` is the control-liveness proof for the whole tier
model. It writes a digest-bearing marker into D1 and into D2 on a running
`office-model`, runs a **real** `rebuild.sh`, and asserts both halves:

1. the D1 marker is present after rebuild with an **identical digest**, and
2. the D2 marker is **gone** after rebuild.

It additionally asserts, from inside `office-model` itself, that no D3 path
exists there — both before and after the rebuild. Asserting only that the
compose file lists a volume is exactly the inert-control failure ADR-005
exists for and is rejected by design; this canary is keyed on evidence the
volume mount (and the missing mount) actually produce.

## Running the drill

`test-office-lifecycle.sh` is a self-contained demonstration that provisions
an **isolated** compose project (unique `OFFICE_PROJECT`, torn down on exit),
runs the durability canary, exercises `recover`, then exercises a full
`snapshot` → write → `restore` cycle and asserts the post-snapshot write is
lost while the pre-snapshot marker survives. It requires Docker and never
touches a real tenant Office.

```sh
./infra/compose/office/test-office-lifecycle.sh
```

Prints `OFFICE_LIFECYCLE_TEST_PASSED` on success.

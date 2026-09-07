# OIK-042 — OpenSandbox server on clawsrv (Docker backend, Tailscale-bound)

**Deployed:** 2026-08-16 by ORCH · **Authority:** `docs/decisions/ADR-006-addendum-b-opensandbox-adoption.md`, `docs/specs/OIKONOMOS_WBS_Addendum_B_v1.0.md` §2 (OIK-042), §5 (R14, R16)

This file is the **only** record of how the server came to run. ADR-006 §4 requires the deployment be reproducible from this document alone — if you cannot rebuild it from what is written here, that is a defect in this file, not tribal knowledge to be recovered from a transcript.

---

## 1. What is deployed

| Item | Value |
|---|---|
| Host | `clawsrv` (Ubuntu 24.04.4 LTS, 8 vCPU, 15 GiB RAM), user `clawusr` |
| Reachable at | `http://100.78.70.2:8080` — **Tailscale interface only** |
| Server image | `opensandbox/server:v0.2.2` |
| Server digest | `sha256:8f8762af7565ed9c6f9dbcf009dd56727aa1fef8ce58a17f2b007b88cfe542bb` |
| execd image | `opensandbox/execd:v1.0.22` |
| execd digest | `sha256:0d8f44cf4194732719aa79999d4b120c98bdab02bc61e9ad13f75f83af4c2684` |
| Container name | `opensandbox-server` (`--restart unless-stopped`) |
| Config | `/home/clawusr/opensandbox/sandbox.toml`, mode `600` |
| Auth | API key required on every request, header `OPEN-SANDBOX-API-KEY` |

**R14 — pinned, not latest.** Both images are pinned by tag *and* recorded by digest above. Do not repoint at `latest`. OpenSandbox is young and its API surface moves; the drift watch (OIK-010) must be extended to cover OpenSandbox release notes.

**R16 — Docker backend only.** The Kubernetes backend is **out of scope** until a real multi-tenant or high-concurrency trigger exists. Moving to Kubernetes is a scheduling decision, not a re-architecture — that is the point of adopting one tool for both. Note the server defaults to the **Kubernetes** service when it cannot read a config file (see §5), so `[runtime] type = "docker"` being loaded is load-bearing, not decorative.

## 2. Why clawsrv made this non-trivial

clawsrv is **not a blank host.** At deployment it was running 13 containers and roughly a dozen native services — Caddy (80/443), Grafana (3030), four Postgres instances (5432/5433/5434 + container-internal), two Redis (6379/6380), ollama (11434), hermes (8642), uptime-kuma, and the skulcozm and lekkerswot stacks. Ports 22, 80, 443, 2019, 3000, 3002, 3009, 3030, 3100, 3579, 5000, 5432–5434, 6379–6380, 8000–8004, 8088–8089, 8101, 8642, 11434, 18789 and 61559 were already occupied.

Two consequences drove the configuration below, and **the second is a security issue rather than a tidiness one**:

1. **8080 was free and verified free** before use. The 29000–32000 band was verified entirely unused.
2. **OpenSandbox's `[docker] network_mode` defaults to `"host"`.** On this host that default would place every sandbox in clawsrv's own network namespace — able to bind host ports on top of the ~25 running services, and able to reach `ollama:11434`, the Caddy admin API on `127.0.0.1:2019`, `lekkerswot_backend:8001` and every local Postgres over loopback. That defeats the entire purpose of deploying an isolation runtime. **`network_mode = "bridge"` is mandatory here**, and is independently required for the per-sandbox egress policy OIK-045b will add.

## 3. Reproducing the deployment from scratch

```bash
ssh clawusr@100.78.70.2

# 1. Pin and pull
docker pull opensandbox/server:v0.2.2
docker pull opensandbox/execd:v1.0.22

# 2. Config directory
mkdir -p ~/opensandbox

# 3. Write ~/opensandbox/sandbox.toml (see §4 for the full file and rationale)

# 4. Generate the API key IN PLACE — never echo it, never paste it anywhere.
#    Non-negotiable #4: no credential in prompts, logs, audit payloads or fixtures.
KEY=$(openssl rand -hex 32)
sed -i "s|^port = 8080$|port = 8080\napi_key = \"$KEY\"|" ~/opensandbox/sandbox.toml
unset KEY
chmod 600 ~/opensandbox/sandbox.toml

# 5. Run. Note `--config` is passed EXPLICITLY (see §5).
docker run -d --name opensandbox-server \
  --restart unless-stopped \
  -p 100.78.70.2:8080:8080 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /home/clawusr/opensandbox/sandbox.toml:/root/.sandbox.toml:ro \
  opensandbox/server:v0.2.2 --config /root/.sandbox.toml
```

Retrieve the key for a client without printing it to a shared surface:
```bash
KEY=$(grep '^api_key' ~/opensandbox/sandbox.toml | sed 's|.*= "\(.*\)"|\1|')
```

## 4. Configuration and why each line is there

`/home/clawusr/opensandbox/sandbox.toml` (api_key redacted):

```toml
[server]
host = "0.0.0.0"          # INSIDE the container only; host exposure is set by the docker publish
port = 8080
api_key = "<64 hex chars>"

[runtime]
type = "docker"           # R16. Without this the server initialises the Kubernetes client and dies.
execd_image = "opensandbox/execd:v1.0.22"

[docker]
network_mode = "bridge"   # NOT the "host" default — see §2.2. Mandatory.
host_ip = "100.78.70.2"
port_range_min = 30000    # 29000-32000 verified unused on clawsrv 2026-08-16
port_range_max = 30999
api_timeout = 180
```

`host = "0.0.0.0"` is safe **because the Tailscale restriction is enforced at the Docker publish** (`-p 100.78.70.2:8080:8080`), not in application config. This matches the convention already used on this host by `skulcozm_*` and `uptime_kuma`. Verified in §6.

## 5. Two upstream behaviours that will waste your time

1. **`SANDBOX_CONFIG_PATH` was not honoured.** Setting the documented environment variable had no effect; the server fell back to its default path, found nothing, and initialised the **Kubernetes** backend, crashing with `KUBERNETES::INITIALIZATION_ERROR`. Pass `--config <path>` as a CLI argument instead. The startup log must read `Loaded configuration from …` followed by `Creating sandbox service with type: docker` — if it does not, the config is not being read and you are on the wrong backend.
2. **The server refuses to start with an empty `api_key`**, offering `OPENSANDBOX_INSECURE_SERVER=YES` as a bypass. **Do not use the bypass.** It is a fail-closed control working correctly; set a real key.

## 6. Verification evidence (2026-08-16)

Tailscale-only was proven by **observed refusal**, not by reading config — ADR-006 §4 and ADR-005 §2 both require evidence a control emits by doing its job:

| Probe | Result |
|---|---|
| `http://204.168.249.99:8080/` (public IPv4, from host) | `curl (7) Failed to connect` — **refused** |
| `http://[2a01:4f9:c014:7d16::1]:8080/` (public IPv6, from host) | `curl (7) Failed to connect` — **refused** |
| `http://127.0.0.1:8080/` (loopback, from host) | `curl (7) Failed to connect` — **refused** |
| `http://100.78.70.2:8080/` (Tailscale, from host) | `401 MISSING_API_KEY` — connected, auth enforced |
| `http://100.78.70.2:8080/` (Tailscale, from a workstation off-host) | `401`, connect 0.22 s — reachable across the tailnet |
| `ss -tlnp \| grep 8080` | single listener `100.78.70.2:8080` — no other binding exists |

End-to-end sandbox lifecycle (Docker backend):

```
POST /v1/sandboxes → 200, state Running
sandbox-6582c2ad-… | net=bridge | 0.0.0.0:30359->8080/tcp, 0.0.0.0:30093->44772/tcp
```

Both allocated host ports fell inside the configured 30000–30999 band, and the sandbox attached to **bridge**, not host — the §2.2 mitigation confirmed working rather than assumed. TTL reaping works: a sandbox created with `timeout: 120` was gone after its window. `DELETE /v1/sandboxes/{id}` returned 204 and left no container behind. All 13 pre-existing containers were untouched throughout.

Minimum valid create body (the API rejects each omission in turn — image must be an object, entrypoint is required with it, and resourceLimits is required without a poolRef):
```json
{"image":{"uri":"…"},"entrypoint":["…"],"resourceLimits":{"cpu":"500m","memory":"512Mi"},"timeout":300}
```

## 7. Known gaps — read before relying on this

1. **Sandbox ports publish on `0.0.0.0`, and ufw does not protect them.** The *server* is Tailscale-bound; individual sandbox port publishes are not, and **OpenSandbox provides no option to change this** — `config.py:831`'s `host_ip` is used only for URL rewriting, and there is no bind-address setting for sandbox publishes. Config cannot fix it.

   The host firewall looks reassuring and is misleading here. `ufw` reports `Status: active`, `Default: deny (incoming)`, `-P INPUT DROP`, with only 22/80/443 open publicly and everything else confined to `tailscale0`. **None of that filters Docker published ports.** A packet to a published port is DNAT'd in `nat/PREROUTING` and traverses the **FORWARD** chain through Docker's own rules — it never reaches `INPUT`, so the ufw ruleset is bypassed entirely. This is the well-known Docker/ufw interaction, and it means "ufw is default-deny" is *not* evidence that ports 30000–30999 are closed.

   Empirically they are closed: port 30359 **timed out** from an external path rather than connecting. But that protection is therefore coming from somewhere other than ufw — most likely an upstream provider firewall (the host's addresses are Hetzner). That layer is outside this host, invisible to `ufw status`, and changeable from a web console by someone who will not know it is load-bearing for sandbox isolation.

   **DECISION 2026-08-16 (Alister): DEFERRED, deliberately — not an oversight.** The remedy below is written and ready; it is not applied yet. Recorded here with its rationale and its trigger so the deferral is a decision with an expiry rather than an intention that evaporates.

   **Why deferring is defensible right now:** nothing runs inside a sandbox yet. The runtime is deployed but unwired — OIK-043 (sandbox lifecycle into `harness-factory`) is gated on OIK-033 and has not landed, so no agent workload, no untrusted code and no browser session currently occupies these ports. The exposure is structural, not live. Applying iptables rules by hand to a production host carrying the live fleet, in order to protect ports nothing is listening on, is the worse trade today.

   **The trigger — this is the part that matters.** Revisit **before the first real workload runs in a sandbox**, i.e. as part of OIK-043, not after a vague "once we've tested live". The moment `harness-factory` creates sandboxes per run, agent-controlled processes occupy this port band and the exposure stops being theoretical. Two further conditions each independently force it earlier: (a) any change to the Hetzner cloud firewall, since that is currently the *only* thing closing these ports and it lives outside this host; (b) any move of this deployment to a host without that upstream filtering.

   **CORRECTED 2026-09-06 (ORCH), after the remedy below was actually applied and empirically failed.** The version originally written here matched `--dport 30000:30999` in `DOCKER-USER` — this can never work, on any host, for a Docker-published port range. `DOCKER-USER` lives in the `filter` table's `FORWARD` chain, which netfilter evaluates *after* `nat`'s `PREROUTING` chain has already DNAT'd the packet's destination to the container's real internal port (e.g. `44772`, not `30746`). By the time `DOCKER-USER` sees the packet, `--dport 30000:30999` can never match — the published port number the rule was written against no longer exists on the packet. This was never caught earlier because the port band was only ever observed closed by the separate, upstream Hetzner cloud firewall (§ above); the local rule itself was inert from day one, on any host. The fix is `-m conntrack --ctorigdstport`, which matches the connection's *original* (pre-NAT) destination port — the value conntrack recorded before PREROUTING rewrote it — rather than the packet's current, post-NAT one:
   ```bash
   PUBIF=$(ip route show default | awk '{print $5; exit}')
   sudo iptables  -I DOCKER-USER 1 -i "$PUBIF" -p tcp -m conntrack --ctorigdstport 30000:30999 -j DROP
   sudo ip6tables -I DOCKER-USER 1 -i "$PUBIF" -p tcp -m conntrack --ctorigdstport 30000:30999 -j DROP
   ```
   Two properties to carry into that work: **it does not survive reboot** unless persisted (`netfilter-persistent save`, or a systemd unit), and **ufw will not manage it and will not show it** — `ufw status` will keep reporting a tidy default-deny while this rule is the thing actually doing the work. Verify by observed refusal from a genuinely independent external path (an online port-checker, or a device on an unrelated network — not a probe launched from infrastructure that might share network peering with the host), never by re-reading `ufw status`, and never by trusting the rule's own packet counter alone until a live external probe has actually incremented it.
   **APPLIED 2026-09-06 (TASK-170/TASK-185).** The corrected IPv4 and IPv6
   `--ctorigdstport` rules above are installed and persisted with
   `netfilter-persistent`; TASK-170 independently observed external refusal
   after applying them. `scripts/verify-docker-user-egress.sh` is the
   mechanical liveness check: it exits non-zero if either installed rule is
   missing or inertly changed back to post-DNAT `--dport` matching. Run it at
   boot and before enabling a sandbox workload.

2. **`Secure runtime is not configured`** appears at startup — no gVisor/Kata/Firecracker. Sandboxes use the default runc isolation. That is acceptable for OIK-042 but is exactly what OIK-045c (isolation strength per capability tier) exists to fix; Tier-3/4 execution must not rely on this deployment as-is.
3. **No liveness assertion yet.** Per CLAUDE.md every mechanical control ships a check that fails when the control is *inert*. There is currently nothing that fails if this server stops, loses its Tailscale-only binding, or silently reverts to `network_mode = "host"`. The third is the dangerous one — it would still serve traffic and pass any naive health check while isolation was gone. Uptime-kuma is already on this host and is the obvious place to start, but a health check alone does not satisfy the rule.
4. **The API key is single, static and host-local.** No rotation procedure exists. Rotation = regenerate per §3 step 4, then `docker restart opensandbox-server`; every client must be updated in the same window.

## 8. Operations

### 8.1 Build the governed office image (TASK-170)

On a machine with this repository checkout, build the harness output first, then
build the image from the repository root (the Dockerfile copies the compiled
hook, not its TypeScript source):

```bash
pnpm --filter @oikonomos/harness-factory build
docker build -f infra/sandbox/images/office-base/Dockerfile -t oikonomos-office-base:claude-2.1.263 .
docker run --rm oikonomos-office-base:claude-2.1.263 claude --version
docker run --rm --entrypoint sh oikonomos-office-base:claude-2.1.263 -c '[ "$(stat -c %U:%a /etc/claude-code/managed-settings.json)" = "root:444" ] && test ! -e "$HOME/.claude.json" && test ! -e "$HOME/.mcp.json"'
```

(The container runs as the unprivileged `sandbox` user per the image's own `USER` directive, so `test -O` — true only when the file is owned by the *effective* user running the check — always evaluates false here by design; it does not test what it looks like it tests. Check the real invariant instead: root ownership and mode 0444, unwritable by `sandbox` regardless of who runs the check.)

Run those commands on `clawsrv` (where OpenSandbox's Docker backend can see the
local tag) before enabling sandbox chat runs. Set
`OIKONOMOS_SANDBOX_IMAGE=oikonomos-office-base:claude-2.1.263` on the worker if
the local tag differs. The image contains neither account credentials nor broker
credentials: the worker injects the short-lived broker token and identity only
into each execd `/command` request.

```bash
docker logs -f opensandbox-server          # startup must show "type: docker"
docker restart opensandbox-server          # after any config change
docker ps --filter name=opensandbox-server
```

Removal, if it must be rolled back:
```bash
docker rm -f opensandbox-server
docker ps -a --filter "ancestor=opensandbox/execd:v1.0.22" -q | xargs -r docker rm -f
# config and images are left in place; delete ~/opensandbox and the images to fully revert
```

## 9. Per-denial egress audit — TASK-202 investigation (2026-09-07), confirms the gap is real and closes it off

TASK-185 descoped the "denial is an audit row" half of its G-08 AC after finding the
pinned server's stable Diagnostics API returns `501 DIAGNOSTICS_NOT_IMPLEMENTED`.
TASK-202 was opened to investigate whether a fix exists before accepting that
permanently. It does not. This section is the complete evidence trail so a future
session doesn't have to re-run this investigation from scratch.

**Method:** all probing below was done against the pinned production deployment
(read-only: `GET`/`POST /sandboxes`, `docker logs`, `docker exec`, `nft list ruleset`
inside a disposable throwaway sandbox, immediately destroyed) plus a **fully
separate, temporary `opensandbox-server` container** on `100.78.70.2:8082` (a
port the production server never uses), with its own throwaway API key and its
own disposable port range (`31000-31199`, outside production's `30000-30999`),
used only to test config/version combinations the *production* server's own
config or pin can't safely be flipped to try. The production `opensandbox-server`
container was never stopped, restarted, or reconfigured; its image digest and
uptime were confirmed unchanged before and after (`sha256:8f87…`, continuous
uptime throughout). All temporary containers, volumes, images, and config files
were destroyed at the end of the session; nothing was left running.

### (a) Does a newer pinned version implement the stable Diagnostics API for real?

Tested three additional versions beyond the pinned `v0.2.2`, against the live
Docker Hub tag list (`v0.1.0`–`v1.0.1` for `server`, egress already at `v1.1.7`,
the newest available):

| Version | Stable Diagnostics API (`/v1/.../diagnostics/*`) | Notes |
|---|---|---|
| `v0.2.2` (pinned) | `501 DIAGNOSTICS_NOT_IMPLEMENTED` on every endpoint, every `scope` value | Confirmed again, live, this session |
| `v0.2.3` (latest 0.2.x) | **Implemented** — but only `scope=container\|all` for logs, `scope=runtime\|all` for events. No `network`/`egress` scope exists; `scope=network` returns `400 DIAGNOSTICS_SCOPE_UNSUPPORTED`, not data. Content returned is byte-identical in shape to the deprecated fallback (execd's own startup banner) — still the workload container only. | Upgrading to `v0.2.3` would fix the *501*, but not the actual gap: there is still no route to the egress sidecar's own logs anywhere in this API, stable or deprecated. |
| `v1.0.1` (latest major) | **Removed entirely.** OpenAPI surface for this version has no `/diagnostics/*` paths at all (`/sandboxes`, `/pause`, `/resume`, `/renew-expiration`, `/endpoints/{port}`, `/health` only — proxy, metadata, snapshots, pools, metrics and diagnostics are all gone). Also drops the `[egress]` config block from `runtime` entirely (moved to `runtime.egress_image`, no `mode` setting survives). | Upgrading here is a straight regression for this task and likely others (TASK-171's PTY viewer story would need re-verification against this API shape too — not evaluated here, out of scope). |

**Conclusion: no available version closes the gap.** `v0.2.3` is the closest fix
candidate for the 501 itself, but confirms — with a real, live 400 response
naming the exact supported scopes — that the sidecar was never reachable through
this API's diagnostics surface at all, in any version. This is a stronger, more
specific finding than TASK-185's original (which only had the 501 to go on and
could not tell whether the *stable* API's design even intended to cover the
sidecar).

### (b) Does the egress sidecar log to a location reachable independently of the workload container?

**The deprecated logs endpoint's own `container` query parameter is dead code
against this Docker backend.** Its OpenAPI description reads "Container name to
read logs from. Defaults to the canonical user container … when the runtime
supports multi-container pods." Tried `container=egress`, `sidecar`,
`egress-sidecar`, `network`, `mitmproxy`, and the sidecar's real Docker container
name (`sandbox-egress-<id>`) — **every value returned the identical workload-container
log content**, byte-for-byte. The parameter is silently ignored by the Docker
backend (plausibly implemented only for the Kubernetes backend's multi-container
pods, which this deployment deliberately does not use per R16). This was not
tested in TASK-185 and closes off a real, previously-open possibility.

**The egress sidecar is a genuinely separate, trustworthy container — this part
of the trust boundary holds.** `docker inspect` confirms the workload container
(`sandbox-<id>`) and the egress sidecar (`sandbox-egress-<id>`) are two distinct
containers with no Docker-socket or privileged access from the workload side;
the workload cannot read, forge, or suppress the sidecar's own `docker logs`
output. Its logs ARE structured JSON and ARE reachable — but only via direct
Docker-host access (`ssh clawsrv && docker logs sandbox-egress-<id>`), not
through any endpoint `packages/audit`'s writer (which does not and should not
have host SSH/Docker-socket access) could call.

**And even with that host-level access, the content is useless for a per-denial
audit.** Live-tested a denied egress attempt (`wget` to both a blocked hostname
and a blocked IP, from inside a real `allowlist_only`-shaped sandbox, confirmed
denied — DNS resolution failed for the hostname, the raw IP connection timed
out) in both of the sidecar's two available enforcement modes:

- **`mode = "dns"` (current production config, per `sandbox.toml` §4):** the
  sidecar's own log shows only startup/policy-load lines. No line, at any log
  level, records the denied query or its target host.
- **`mode = "dns+nft"`** (the only other value the pinned schema accepts —
  `"proxy"` is rejected outright by `pydantic`'s own `Literal["dns", "dns+nft"]`
  validation, confirmed live with the exact rejection message): same result.
  Additionally pulled the live `nft list ruleset` from inside the sidecar
  container after the denied attempt — the `egress` chain's final `drop` is a
  bare catch-all with **no per-rule `log` statement**, so even the kernel's own
  `dmesg`/netfilter log carries no per-IP attribution. A drop event increments
  an aggregate counter only; there is no way to recover which host was denied
  from any artifact this sidecar produces, in either mode, at any layer.
- The `system.py` mitmproxy addon shipped inside the `opensandbox/egress:v1.1.7`
  image (visible via `docker exec … cat`) does full per-request/per-SNI logging
  and redaction — but it is **unreachable**: there is no `mode` value in the
  pinned server's own config schema that ever invokes it. It is present in the
  image for a code path this server version does not expose.

### Net conclusion — do not implement, per this task's own Description

*"Do not ship a per-denial audit mechanism whose trust boundary can't be
verified"* — and per-host denial data does not exist anywhere in this
deployment's reach, trustworthy or not, in any combination of pinned version,
upgrade candidate, or enforcement mode tried. There is nothing to wire into
`audit_events`; inventing a value (e.g. logging "some egress was denied" without
the host) would misrepresent AC2's own literal requirement ("identifying the
denied host") and is exactly the kind of dishonest-strength claim CLAUDE.md's
liveness-assertion rule and TASK-185's own prior descoping decision both warn
against. `packages/audit/src/index.ts` is unchanged by this investigation.

**What would actually close this gap**, for whoever picks it up next: either (1)
an upstream OpenSandbox feature request/PR adding a `network`/`egress`
diagnostics scope or a `log` statement to the sidecar's generated nftables rules
with a source we could reach without host SSH access, or (2) building and
operating our own log-forwarding sidecar/volume-mount replacing the vendored one
(a materially bigger investment — real ongoing maintenance of a second sidecar
image — not a narrow follow-up task). Recommend this stay descoped as TASK-185
already decided, human-confirmed, rather than either of those being taken on
speculatively.

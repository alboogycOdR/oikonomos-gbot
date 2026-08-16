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

1. **Sandbox ports publish on `0.0.0.0`, not the Tailscale address.** The *server* is Tailscale-bound; individual sandbox port publishes are not. From an external network path port 30359 **timed out** (packets dropped upstream) rather than connecting, so it is not currently reachable — but that protection comes from a firewall this deployment does not own and **could not be inspected** (`clawusr` has no passwordless sudo, so `ufw`/`iptables` state is unverified). If that upstream filtering is ever relaxed, sandbox ports become publicly exposed. Treat as an open item: confirm the host firewall posture, and investigate whether OpenSandbox can bind sandbox publishes to a specific interface.
2. **`Secure runtime is not configured`** appears at startup — no gVisor/Kata/Firecracker. Sandboxes use the default runc isolation. That is acceptable for OIK-042 but is exactly what OIK-045c (isolation strength per capability tier) exists to fix; Tier-3/4 execution must not rely on this deployment as-is.
3. **No liveness assertion yet.** Per CLAUDE.md every mechanical control ships a check that fails when the control is *inert*. There is currently nothing that fails if this server stops, loses its Tailscale-only binding, or silently reverts to `network_mode = "host"`. The third is the dangerous one — it would still serve traffic and pass any naive health check while isolation was gone. Uptime-kuma is already on this host and is the obvious place to start, but a health check alone does not satisfy the rule.
4. **The API key is single, static and host-local.** No rotation procedure exists. Rotation = regenerate per §3 step 4, then `docker restart opensandbox-server`; every client must be updated in the same window.

## 8. Operations

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

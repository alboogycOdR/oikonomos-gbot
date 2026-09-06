import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";

// TASK-185: originally queried the sidecar's `/policy` endpoint to confirm
// the SPECIFIC intended ruleset was live, not just sidecar presence. Live
// testing against a real clawsrv sandbox (2026-09-06) found `/policy`
// requires an `OPENSANDBOX-EGRESS-AUTH` header carrying `OPENSANDBOX_EGRESS_TOKEN`
// — an env var the OpenSandbox server only injects into the egress SIDECAR
// container, never into this (the workload) container; confirmed absent from
// `docker inspect`'s own `Config.Env` for the main container, and no shared
// file/volume carries it either. There is no supported way for code running
// here to authenticate to `/policy`, so proving the exact rule content is
// live is not achievable from inside the sandbox with this deployment.
// Falls back to `/healthz` (documented unauthenticated, verified live:
// `200 ok` from inside a real sandbox) — a genuinely weaker guarantee (it
// proves the egress sidecar is present, listening, and its mitmproxy is
// ready; it does NOT prove the specific allowlist this run expected is what
// got loaded) but a real one: a sandbox with NO sidecar at all (missing
// server config, creation raced ahead of the sidecar, etc.) still fails
// closed here exactly as before, since there is nothing to answer on 18080.
// Recorded as an open, honest gap in the dossier — same class of descope as
// this task's other AC2 audit-trust narrowing — not silently upgraded to a
// stronger claim than the evidence supports.
const command = process.argv.slice(2);
try {
  const response = await fetch("http://127.0.0.1:18080/healthz", { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("egress sidecar not ready");
  await mkdir("/run/oikonomos", { recursive: true, mode: 0o755 });
  await writeFile("/run/oikonomos/egress-policy-applied", "applied\n", { mode: 0o444 });
} catch {
  // No sidecar (or an unhealthy one) leaves no marker; the worker refuses governed commands.
}

const child = spawn("setpriv", ["--reuid=sandbox", "--regid=sandbox", "--init-groups", "--", ...command], { stdio: "inherit" });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal === null ? 1 : 128); });

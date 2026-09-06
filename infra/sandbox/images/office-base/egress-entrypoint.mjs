import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";

const command = process.argv.slice(2);
try {
  const response = await fetch("http://127.0.0.1:18080/policy", { signal: AbortSignal.timeout(10_000) });
  const body = await response.json();
  if (!response.ok || body.status !== "ok" || body.policy === undefined) throw new Error("egress policy unavailable");
  await mkdir("/run/oikonomos", { recursive: true, mode: 0o755 });
  await writeFile("/run/oikonomos/egress-policy-applied", "applied\n", { mode: 0o444 });
} catch {
  // No sidecar leaves no marker; the worker refuses governed commands.
}

const child = spawn("setpriv", ["--reuid=sandbox", "--regid=sandbox", "--init-groups", "--", ...command], { stdio: "inherit" });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal === null ? 1 : 128); });

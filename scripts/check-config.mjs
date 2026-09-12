#!/usr/bin/env node
// TASK-240 — required-configuration check. Prints each variable's NAME and
// present/absent ONLY. It never prints, logs, hashes, or echoes a value, and
// it reads the process environment (not files), so it cannot be pointed at a
// secrets file by accident. Exit 1 if any REQUIRED variable is absent.
//
// Why this exists: on 2026-09-12 the global capability kill-switch
// OIKONOMOS_CAPABILITIES_ENABLED was found unset in this environment, which
// had silently denied every governed tool call in production. A deploy step
// that names every required variable makes that class of outage visible
// before the first user notices.
//
// Usage: node scripts/check-config.mjs [--service control-api|worker|all]
// Values are checked with a fresh registry read on Windows when --user-scope
// is passed (a just-rotated User-scope variable is not visible to an
// already-running process tree; see PLAN.md orchestrator_notes lesson 5/8).

import { execFileSync } from "node:child_process";

const REQUIRED = {
  common: [
    "DATABASE_URL",
    "OIKONOMOS_CAPABILITIES_ENABLED", // kill-switch; must be "true" for any governed call to run
    "OIK_SECRET_BROKER_TOKEN_SIGNING_KEY",
  ],
  "control-api": ["CONTROL_API_TOKEN"],
  worker: [
    "OIK_SANDBOX_BROKER_URL",
    "OIK_SECRET_OPENSANDBOX_API_KEY",
    "GEMINI_API_KEY",
  ],
};
const OPTIONAL = [
  // FIREBASE_PROJECT_ID defaults in app.ts:771; OIK_SECRET_VAULT_KEY is read only by
  // packages/db/src/secretVault.ts, which has no production composition site as of
  // 2026-09-12 (finding recorded in PLAN.md TASK-240 notes) — required once wired.
  "FIREBASE_PROJECT_ID", "OIK_SECRET_VAULT_KEY",
  "PORT", "BROKER_PORT", "OIK_TENANT_ID", "OIK_ATTACHMENTS_DIR",
  "OIKONOMOS_HOST_MODEL", "OIKONOMOS_SANDBOX_MODEL", "OIKONOMOS_SANDBOX_IMAGE",
  "OIK_PROVIDER_CAP_USD_GEMINI", "USD_TO_ZAR_RATE",
  "OIK_SECRET_ANTHROPIC_API_KEY", "OIK_SECRET_MCP_GMAIL_URL",
  "OIK_SECRET_GMAIL_OAUTH_CLIENT_ID", "OIK_SECRET_GMAIL_OAUTH_CLIENT_SECRET", "OIK_SECRET_GMAIL_OAUTH_REFRESH_TOKEN",
  "OIK_SECRET_OPENSANDBOX_EXECD_ACCESS_TOKEN",
  "FREE_LLM_API_ENDPOINT", "FREE_LLM_API_KEY", "FREE_LLM_API_MODEL",
  "OIKONOMOS_BUILD_SHA", "DASHBOARD_STATIC_PORT",
];

const args = process.argv.slice(2);
const service = args.includes("--service") ? args[args.indexOf("--service") + 1] : "all";
const userScope = args.includes("--user-scope") && process.platform === "win32";

function present(name) {
  if (userScope) {
    // Registry-direct read; output is only the length, never the value.
    // Windows PowerShell 5.1 syntax (no `??`): the scheduled watchdog and the
    // runbook both run under `powershell.exe`, not pwsh.
    const out = execFileSync("powershell.exe", [
      "-NoProfile", "-Command",
      `$v=[Environment]::GetEnvironmentVariable('${name}','User'); if ($v) { $v.Length } else { 0 }`,
    ], { encoding: "utf8" }).trim();
    return Number(out) > 0;
  }
  const v = process.env[name];
  return typeof v === "string" && v.length > 0;
}

const required = [
  ...REQUIRED.common,
  ...(service === "all" ? [...REQUIRED["control-api"], ...REQUIRED.worker] : REQUIRED[service] ?? []),
];

let missing = 0;
console.log(`config check (${service}${userScope ? ", User-scope registry read" : ", process env"})`);
for (const name of required) {
  const ok = present(name);
  if (!ok) missing += 1;
  console.log(`  ${ok ? "present" : "ABSENT "}  ${name}`);
}
console.log("optional:");
for (const name of OPTIONAL) console.log(`  ${present(name) ? "present" : "absent "}  ${name}`);
if (present("OIKONOMOS_CAPABILITIES_ENABLED") && process.env.OIKONOMOS_CAPABILITIES_ENABLED !== undefined
    && process.env.OIKONOMOS_CAPABILITIES_ENABLED !== "true") {
  // The only value this script ever inspects is a boolean flag, by design.
  console.log("  WARNING  OIKONOMOS_CAPABILITIES_ENABLED is set but not 'true' — every governed call will be denied");
  missing += 1;
}
if (missing > 0) {
  console.error(`\n${missing} required item(s) missing or wrong. Refusing.`);
  process.exit(1);
}
console.log("\nall required variables present");

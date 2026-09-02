// TASK-060 — persistent-office vertical-slice demo.
//
// Demonstrates, live, on real infrastructure: a task in via Telegram, a
// governed run, an ENFORCED-FLOOR action parking for real approval, a
// real phone tap resolving it, a real single-use nonce consumption, a
// separately-denied D3 secret-path attempt, and an autonomous action
// executing without any card — the two halves ADR-010 §5.4 requires to
// actually demonstrate the pivot (not just one).
//
// Real: Postgres (roles/tasks/runs/approvals/audit_events), the broker's
// L1 decision path (packages/broker), the real six-rank resolver
// (packages/policy), the real D3 guard (packages/broker/secretPathGuard),
// real nonce-bound single-use approval consumption (packages/approvals),
// control-api as a real running HTTP server, a real Telegram bot round
// trip to the operator's phone.
//
// Scripted (disclosed, matching the TASK-054/055 demo precedent): the tool
// calls a "model" would normally choose are presented deterministically by
// this script rather than by a live LLM conversation, so the enforcement
// and persistence proof is 100% real while the "what to do next" decision
// is scripted. The "local execution" action, once approved, is logged as
// approved and NOT actually executed on this machine — approval unlocks
// the capability, it does not obligate this script to run an arbitrary
// command, and doing so for real would be an unnecessary risk for a demo.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import { Database, createRole, startRun, getRun, insertAuditEvent } from "../../../packages/db/dist/index.js";
import { issueApproval, verifyAndConsume } from "../../../packages/approvals/dist/index.js";
import { toDecisionAuditEvent } from "../../../packages/audit/dist/index.js";
import { handlePreToolUse } from "../../../packages/broker/dist/index.js";
import { composeHarness } from "../../../packages/harness-factory/dist/compose.js";
import { createControlApiHttpClient } from "../../../services/gateway-telegram/dist/index.js";
import { createTelegramRuntime } from "./telegram-runtime.mjs";

const DATABASE_URL = process.env.DATABASE_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!DATABASE_URL) throw new Error("DATABASE_URL not set");
if (!TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN not set");

const dbOptions = { connectionString: DATABASE_URL };
const TENANT = "office-demo";
const ROLE_ID = "office-demo-inbox-triage";
const CONTROL_API_PORT = 3099;
const controlApiUrl = `http://127.0.0.1:${CONTROL_API_PORT}`;

function log(...args) {
  console.log(`[demo ${new Date().toISOString()}]`, ...args);
}

// --- 1. Start control-api as a real HTTP server -----------------------
async function startControlApi() {
  log("starting control-api on port", CONTROL_API_PORT, "...");
  // Invoke start() explicitly rather than relying on index.ts's
  // import.meta.url===process.argv[1] entrypoint guard, which does not
  // reliably match on Windows (backslash vs. URL path separators).
  const proc = spawn(
    process.execPath,
    ["-e", "import('./services/control-api/dist/index.js').then((m) => m.start())"],
    {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(CONTROL_API_PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  proc.stdout.on("data", (d) => process.stdout.write(`[control-api] ${d}`));
  proc.stderr.on("data", (d) => process.stderr.write(`[control-api] ${d}`));
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${controlApiUrl}/openapi.json`);
      if (res.ok) {
        log("control-api is up.");
        return proc;
      }
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error("control-api did not become healthy in time");
}

// --- 2. A real, minimal governed brokerDependencies set ----------------
const CAPABILITIES = new Map([
  ["email.list", { toolName: "email.list", capabilityId: "email.list", defaultTier: "T0_observe" }],
  [
    "office.local_execute",
    {
      toolName: "office.local_execute",
      capabilityId: "office.local_execute",
      defaultTier: "T2_internal",
      enforcementEnabled: true,
      enforcedActionClasses: ["E3_local_machine_execution"],
    },
  ],
]);

function brokerDependencies(runId) {
  return {
    isCapabilitiesEnabled: () => true,
    getCapability: async (toolName) => CAPABILITIES.get(toolName) ?? null,
    getRoleGrant: async () => ({ maxTier: "T2_internal" }),
    destinationFor: (request) => String(request.input?.target ?? "office-demo"),
    issueApproval: async (request, deps) => issueApproval(request, deps),
    verifyAndConsume: async (nonce, deps) => verifyAndConsume(nonce, deps),
    issueApprovalDependencies: { database: dbOptions },
    consumeDependencies: { database: dbOptions },
    recordDecision: async (event) => {
      const row = await insertAuditEvent(dbOptions, toDecisionAuditEvent({ ...event, runId, tenantId: TENANT }));
      return { eventId: row.eventId };
    },
  };
}

// --- 3. Scripted tool-attempt presenter (matches services/worker's own
//        test-fixture pattern for driving L1 through a scripted queryFn) --
async function presentToolAttempt(queryInput, attempt) {
  const hooks = queryInput.options?.hooks;
  const hook = hooks?.PreToolUse?.[0]?.hooks?.[0];
  const output = await hook(
    { hook_event_name: "PreToolUse", tool_name: attempt.toolName, tool_use_id: attempt.toolUseId, tool_input: attempt.toolInput },
    attempt.toolUseId,
    { signal: new AbortController().signal },
  );
  const decision = output?.hookSpecificOutput;
  return { allowed: decision?.permissionDecision !== "deny", reason: decision?.permissionDecisionReason };
}

async function* scriptedQuery(queryInput, steps, results) {
  for (const step of steps) {
    const outcome = await presentToolAttempt(queryInput, step);
    results.push({ ...step, outcome });
    log(`tool_use ${step.toolName} ->`, outcome.allowed ? "ALLOWED" : `DENIED (${outcome.reason ?? "parked/denied"})`);
    if (!outcome.allowed) {
      // Enforced (parked or denied) — this scripted run stops here, matching
      // this project's own "no checkpoint/resume" design (ADR-010/Addendum F
      // §3.4): an interrupted run ends, the next step is a fresh run.
      return;
    }
  }
  yield { type: "assistant", session_id: "office-demo", message: { content: [] } };
}

async function runOnce(runId, role, steps) {
  const results = [];
  const runtime = composeHarness({
    run: { runId, roleId: role, tenantId: TENANT, agentRef: { provider: "office-demo", sessionRef: runId, isSubagent: false } },
    allowedTools: [...CAPABILITIES.keys(), "connector.read_file"].map((t) => `${t}(*)`),
    auditSink: { writeCompletionEvidence: async () => {} },
    queryFn: (input) => scriptedQuery(input, steps, results),
    pretooluse: { handlePreToolUse, dependencies: brokerDependencies(runId) },
  });
  for await (const _ of runtime.harness.query({ prompt: "office-demo scripted run" })) {
    // drain
  }
  return results;
}

// --- main ----------------------------------------------------------------
async function main() {
  const database = new Database(dbOptions);
  await createRole(dbOptions, { roleId: ROLE_ID, tenantId: TENANT, name: "inbox-triage", title: "Inbox Triage (demo)" });
  // approvals.capability_id carries a real FK to the capabilities table —
  // the capability declaration must exist there for issueApproval to
  // succeed, not just in this script's in-memory brokerDependencies.
  for (const [, cap] of CAPABILITIES) {
    await database.upsertCapability({
      capabilityId: cap.capabilityId,
      description: `office-demo: ${cap.capabilityId}`,
      defaultTier: cap.defaultTier,
      adapter: "office-demo",
      enabled: true,
    });
  }

  const controlApiProc = await startControlApi();
  const controlApi = createControlApiHttpClient(controlApiUrl);
  const telegram = createTelegramRuntime(TELEGRAM_BOT_TOKEN);

  log("waiting for a message from you in the bot chat to trigger the run (any text)...");
  const chatId = await new Promise((resolve) => {
    telegram.onMessage(async (msg) => {
      log(`received trigger from chat ${msg.chatId}: "${msg.text}"`);
      resolve(msg.chatId);
    });
    void telegram.start();
  });

  await telegram.sendMessage(chatId, "Starting a governed persistent-office demo run...");

  // RUN 1: an autonomous read, then a parking enforced-floor attempt.
  const task1 = await controlApi.createTask({ roleId: ROLE_ID, title: "office-demo run 1", goal: "list then attempt local execution", requestedBy: `telegram:${chatId}` });
  const run1 = await startRun(dbOptions, { taskId: task1.taskId, tenantId: TENANT, provider: "office-demo" });
  const steps1 = await runOnce(run1.runId, ROLE_ID, [
    { toolName: "email.list", toolUseId: "call-1", toolInput: { target: "inbox" } },
    { toolName: "office.local_execute", toolUseId: "call-2", toolInput: { target: "local-shell", command: "echo demo" } },
  ]);
  const autonomousStep = steps1[0];
  const parkedStep = steps1[1];
  log("run 1 complete.", JSON.stringify(steps1.map((s) => ({ tool: s.toolName, allowed: s.outcome.allowed }))));

  // Find the pending approval control-api now sees for this run.
  let pending = [];
  for (let i = 0; i < 10 && pending.length === 0; i++) {
    pending = (await controlApi.listPendingApprovals()).filter((a) => a.runId === run1.runId);
    if (pending.length === 0) await sleep(300);
  }
  if (pending.length === 0) {
    throw new Error("expected a pending approval for the parked office.local_execute attempt, found none");
  }
  const approval = pending[0];
  log("real approval pending, nonce issued, sending Telegram card...");

  await telegram.sendApprovalMessage(
    chatId,
    `Approval needed (enforced floor E3 — local machine execution):\n${approval.actionRender}`,
    [[{ text: "Approve", callbackData: `approval:approve:${approval.approvalId}` }, { text: "Reject", callbackData: `approval:reject:${approval.approvalId}` }]],
  );

  log("waiting for your tap on the phone...");
  const decision = await new Promise((resolve) => {
    telegram.onApprovalCallback(async (cb) => {
      const [, action] = cb.data.split(":");
      await telegram.answerApprovalCallback(cb.callbackId, action === "approve" ? "Approved." : "Rejected.");
      resolve(action === "approve" ? "granted" : "rejected");
    });
  });
  log(`you decided: ${decision}`);
  const consumeResult = await controlApi.decideApproval(approval.nonce, decision, `telegram:user:${chatId}`);
  log("real control-api decideApproval result:", JSON.stringify(consumeResult));

  if (decision === "granted") {
    await telegram.sendMessage(chatId, "Approved — office.local_execute is now authorized (not actually run on this machine for demo safety). Continuing...");
  } else {
    await telegram.sendMessage(chatId, "Rejected — the action will not run.");
  }

  // RUN 2 (new run — no checkpoint/resume, per ADR-010): demonstrate the
  // DENY half using the already-shipped, already-proven D3 guard.
  const task2 = await controlApi.createTask({ roleId: ROLE_ID, title: "office-demo run 2", goal: "attempt a sealed-secret path read", requestedBy: `telegram:${chatId}` });
  const run2 = await startRun(dbOptions, { taskId: task2.taskId, tenantId: TENANT, provider: "office-demo" });
  const steps2 = await runOnce(run2.runId, ROLE_ID, [
    { toolName: "connector.read_file", toolUseId: "call-3", toolInput: { target: "/oikonomos-secrets/cookie-store" } },
  ]);
  const deniedStep = steps2[0];
  log("run 2 (D3 attempt) complete.", JSON.stringify({ tool: deniedStep.toolName, allowed: deniedStep.outcome.allowed, reason: deniedStep.outcome.reason }));

  await telegram.sendMessage(
    chatId,
    `Demo complete.\nAutonomous action executed without a card: ${autonomousStep.toolName} (allowed=${autonomousStep.outcome.allowed}).\nEnforced-floor action ${decision === "granted" ? "approved by you" : "rejected by you"}.\nSealed-secret path read: DENIED (${deniedStep.outcome.reason ?? "E5_d3_path_access"}).`,
  );

  telegram.stop();
  controlApiProc.kill();
  await database.close();

  console.log("\n=== SUMMARY (for the runbook) ===");
  console.log(JSON.stringify({
    run1: run1.runId,
    run2: run2.runId,
    autonomous: { tool: autonomousStep.toolName, allowed: autonomousStep.outcome.allowed },
    enforcedFloorParked: { tool: parkedStep.toolName, allowed: parkedStep.outcome.allowed, approvalId: approval.approvalId, decision, consumeResult },
    d3Denied: { tool: deniedStep.toolName, allowed: deniedStep.outcome.allowed, reason: deniedStep.outcome.reason },
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

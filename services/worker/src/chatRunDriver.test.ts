import {
  Database,
  createRole,
  createTask,
  defaultPoolConfig,
  getAuditEventsForRun,
  listMessages,
  listRuns,
  type DatabaseOptions,
} from "@oikonomos/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createChatRunDriver, destinationFor, finalText } from "./chatRunDriver.js";

const chatRunDriverSource = await import("node:fs/promises").then((fs) =>
  fs.readFile(new URL("./chatRunDriver.ts", import.meta.url), "utf8"),
);

const base = {
  toolUseId: "tool-use", runId: "11111111-1111-1111-1111-111111111111", roleId: "chat-bot", tenantId: "basileia",
  agentRef: { provider: "claude", sessionRef: "session", isSubagent: false },
};

describe("chat run driver governance helpers", () => {
  it("uses the scoped built-in mount while leaving Agent SDK query ownership to harness-factory", () => {
    expect(chatRunDriverSource).toContain('allowedTools: ["Bash(*)", "Read(*)"]');
    expect(chatRunDriverSource).not.toMatch(/queryFn\s*:/);
    expect(chatRunDriverSource).not.toContain("@anthropic-ai/claude-agent-sdk");
  });

  it("derives only ADR-013's approved destinations and fails closed otherwise", () => {
    expect(destinationFor({ ...base, toolName: "Read", input: { file_path: "src/app.ts" } })).toBe("src/app.ts");
    expect(destinationFor({ ...base, toolName: "Glob", input: { pattern: "src/**/*.ts" } })).toBe("src/**/*.ts");
    expect(destinationFor({ ...base, toolName: "Bash", input: { command: "git status" } })).toBe("git status");
    expect(destinationFor({ ...base, toolName: "mcp__gmail__send_message", input: { to: "user@example.test" } })).toBe("user@example.test");
    expect(() => destinationFor({ ...base, toolName: "WebFetch", input: { url: "https://example.test" } })).toThrow(/No governed destination/);
  });

  it("uses the final SDK result while keeping a non-empty fallback reply", () => {
    expect(finalText([{ result: "first" }, { type: "progress" }, { result: " final reply " }])).toBe("final reply");
    expect(finalText([{ type: "progress" }])).toMatch(/completed/);
  });
});

// TASK-116: closes the gap flagged in TASK-111's own Review_Findings — the
// live governed-execution claim was independently verified by ORCH against
// real production Postgres, but nothing here would catch a future
// regression. This drives `createChatRunDriver(...).run(...)` for real: a
// real Postgres task/thread, a real Claude Agent SDK call (real inference
// spend — see the dossier for actual cost), and real assertions against
// Postgres afterward. Zero-grant deny path (ADR-013 §7's own suggested
// alternative to seeding a grant): a freshly created role_id has no
// `role_grants` row, so the broker's `role.grant_missing` deny fires the
// instant the model attempts its one Bash call — a real `policy.decision`
// audit event for `runtime.bash`/`T3_external`, same evidentiary bar as
// CAN-09, without needing to seed a grant or drive the approval-pending
// park path (already covered by TASK-111's own live verification note).
const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("createChatRunDriver — real governed chat run (TASK-116)", () => {
  let pool: Pool;
  let options: DatabaseOptions;
  const roleId = "task-116-chat-run-driver-suite";
  let task: Awaited<ReturnType<typeof createTask>>;
  let taskId: string;
  let threadId: string;
  const previousCapabilitiesEnabled = process.env.OIKONOMOS_CAPABILITIES_ENABLED;

  async function cleanup(): Promise<void> {
    await pool.query(
      `DELETE FROM audit_events WHERE run_id IN (SELECT run_id FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1))`,
      [roleId],
    );
    await pool.query(
      `DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE role_id = $1)`,
      [roleId],
    );
    await pool.query(
      `DELETE FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1)`,
      [roleId],
    );
    await pool.query(`DELETE FROM tasks WHERE role_id = $1`, [roleId]);
    await pool.query(`DELETE FROM threads WHERE role_id = $1`, [roleId]);
    await pool.query(`DELETE FROM role_grants WHERE role_id = $1`, [roleId]);
    await pool.query(`DELETE FROM roles WHERE role_id = $1`, [roleId]);
  }

  beforeAll(async () => {
    // isCapabilitiesEnabled() reads this per-call (ADR-013's suggested v1) —
    // without it the broker denies at "capability.disabled" before ever
    // reaching getCapability/getRoleGrant, which would prove nothing about
    // ADR-013 §7's grant path.
    process.env.OIKONOMOS_CAPABILITIES_ENABLED = "true";
    options = { connectionString: connectionString! };
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();

    // Deliberately zero role_grants for this role: the test exercises
    // ADR-013 §7's zero-grant deny path, not the seeded-grant path.
    await createRole(options, {
      roleId,
      name: roleId,
      title: "TASK-116 governed chat run fixture role",
      description: "TASK-116 chatRunDriver integration fixture — intentionally grant-less.",
    });

    task = await createTask(options, {
      roleId,
      title: "TASK-116 governed chat run fixture",
      goal: "Run `pwd` via Bash exactly once, then stop.",
      requestedBy: "task-116-suite",
    });
    taskId = task.taskId;

    const thread = await pool.query<{ id: string }>(
      "INSERT INTO threads (role_id) VALUES ($1) RETURNING id",
      [roleId],
    );
    threadId = thread.rows[0]!.id;
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
    if (previousCapabilitiesEnabled === undefined) delete process.env.OIKONOMOS_CAPABILITIES_ENABLED;
    else process.env.OIKONOMOS_CAPABILITIES_ENABLED = previousCapabilitiesEnabled;
  });

  it(
    "drives a real chat run end-to-end: policy.decision audit event, a bot reply, and a completed run",
    async () => {
      const driver = createChatRunDriver(options);

      await driver.run({ task, threadId });

      const runsPage = await listRuns(options, { taskId });
      expect(runsPage.runs).toHaveLength(1);
      const run = runsPage.runs[0]!;
      expect(run.status).toBe("completed");
      expect(run.endedAt).not.toBeNull();

      const events = await getAuditEventsForRun(options, run.runId);
      const decision = events.find((event) => event.eventType === "policy.decision" && event.capability === "runtime.bash");
      expect(decision).toBeDefined();
      expect(decision?.tier).toBe("T3_external");
      // Zero role_grants ⇒ ADR-013 §7's role.grant_missing deny reason,
      // fired before any tier-ceiling/approval logic is even reached.
      expect(decision?.payload).toMatchObject({ toolName: "Bash", reason: "role.grant_missing", verdict: "deny" });

      const messages = await listMessages(options, threadId);
      const botMessage = messages.find((message) => message.role === "bot" && message.runId === run.runId);
      expect(botMessage).toBeDefined();
      expect(botMessage?.body.length).toBeGreaterThan(0);
    },
    120_000,
  );

  it(
    "completes a real mounted Read action with its T0 role grant and no pending approval",
    async () => {
      const database = new Database(options);
      try {
        await database.upsertRoleGrant({
          roleId,
          capabilityId: "fs.read",
          maxTier: "T0_observe",
          constraints: {},
        });
      } finally {
        await database.close();
      }
      const readTask = await createTask(options, {
        roleId,
        title: "TASK-117 T0 Read grant fixture",
        goal: "Use Read to read package.json exactly once. Do not use Bash or any other tool, then report the package name.",
        requestedBy: "task-117-suite",
      });

      await createChatRunDriver(options).run({ task: readTask, threadId });

      const runsPage = await listRuns(options, { taskId: readTask.taskId });
      const run = runsPage.runs[0]!;
      expect(run.status).toBe("completed");
      const events = await getAuditEventsForRun(options, run.runId);
      expect(events.find((event) => event.eventType === "policy.decision" && event.capability === "fs.read"))
        .toMatchObject({ tier: "T0_observe", payload: { toolName: "Read", verdict: "allow" } });
      const approvals = await pool.query<{ count: string }>(
        "SELECT count(*) FROM approvals WHERE run_id = $1 AND status = 'pending'",
        [run.runId],
      );
      expect(approvals.rows[0]!.count).toBe("0");
    },
    120_000,
  );
});

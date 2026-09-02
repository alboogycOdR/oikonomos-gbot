import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createRole, defaultPoolConfig, type DatabaseOptions, type NewRoleMessage, type RoleMessage } from "@oikonomos/db";
import { Pool } from "pg";

import { handoffKinds, sendToRole, type SendToRoleDeps } from "./mailbox.js";

const options: DatabaseOptions = { connectionString: "postgres://x" };

function fakeDeps(): { deps: SendToRoleDeps; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async (_options: DatabaseOptions, input: NewRoleMessage): Promise<RoleMessage> => ({
    messageId: "11111111-1111-1111-1111-111111111111",
    tenantId: input.tenantId ?? "basileia",
    fromRoleId: input.fromRoleId,
    toRoleId: input.toRoleId,
    body: input.body,
    workspaceRefs: input.workspaceRefs ?? [],
    handoffKind: input.handoffKind ?? null,
    factRef: input.factRef ?? null,
    createdAt: new Date("2026-09-02T00:00:00Z"),
    readAt: null,
  }));
  return { deps: { send }, send };
}

describe("sendToRole typed handoffs (TASK-099)", () => {
  it("exports the closed handoff-kind set and persists a locator with no value", async () => {
    expect(handoffKinds).toEqual(["research.complete", "draft.ready_for_review"]);
    const { deps, send } = fakeDeps();
    await sendToRole(
      options,
      {
        tenantId: "tenant-a",
        fromRoleId: "researcher",
        toRoleId: "drafter",
        body: "Research is ready.",
        handoffKind: "research.complete",
        factRef: { tenantId: "tenant-a", scope: "project", projectId: "project-a", key: "research" },
      },
      deps,
    );

    const [, persisted] = send.mock.calls[0] as [DatabaseOptions, NewRoleMessage];
    expect(persisted.handoffKind).toBe("research.complete");
    expect(persisted.factRef).toEqual({
      tenantId: "tenant-a",
      scope: "project",
      projectId: "project-a",
      key: "research",
    });
    expect("value" in (persisted.factRef ?? {})).toBe(false);
  });

  it.each([
    { handoffKind: "research.complete" as const },
    { factRef: { tenantId: "tenant-a", scope: "user" as const, key: "research" } },
  ])("rejects an incomplete typed-handoff pair before the database write", async (typedFields) => {
    const { deps, send } = fakeDeps();
    await expect(
      sendToRole(options, { fromRoleId: "researcher", toRoleId: "drafter", body: "x", ...typedFields }, deps),
    ).rejects.toThrow(/handoffKind and factRef/);
    expect(send).not.toHaveBeenCalled();
  });
});

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("sendToRole typed handoff — mailbox to live memory (TASK-099)", () => {
  let pool: Pool;
  const tenantId = "task-099-mailbox-suite";
  const fromRoleId = "task-099-researcher";
  const toRoleId = "task-099-drafter";
  const projectId = "task-099-project";
  const key = "research.findings";
  const liveValue = "Only the memory store owns this live value.";

  async function cleanup(): Promise<void> {
    await pool.query(`DELETE FROM role_messages WHERE tenant_id = $1`, [tenantId]);
    await pool.query(`DELETE FROM profile_facts WHERE tenant_id = $1`, [tenantId]);
    await pool.query(`DELETE FROM roles WHERE role_id IN ($1, $2)`, [fromRoleId, toRoleId]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();
    await createRole({ connectionString: connectionString! }, { roleId: fromRoleId, tenantId, name: "Researcher", title: "Researcher" });
    await createRole({ connectionString: connectionString! }, { roleId: toRoleId, tenantId, name: "Drafter", title: "Drafter" });
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("persists only the fact locator, then resolves the recipient's live fact", async () => {
    const memory = await import("../../../packages/memory/dist/index.js");
    await memory.writeMemoryFact(
      { connectionString: connectionString! },
      { tenantId, scope: "project", projectId, key, value: liveValue, source: "task-099-test", visibleTo: [toRoleId] },
    );
    const acknowledgement = await sendToRole(
      { connectionString: connectionString! },
      {
        tenantId,
        fromRoleId,
        toRoleId,
        body: "Research complete; read the live fact.",
        handoffKind: "research.complete",
        factRef: { tenantId, scope: "project", projectId, key },
      },
    );
    const persisted = await pool.query<{ handoff_kind: string; fact_ref: Record<string, unknown> }>(
      `SELECT handoff_kind, fact_ref FROM role_messages WHERE message_id = $1`, [acknowledgement.messageId],
    );
    expect(persisted.rows[0]).toEqual({ handoff_kind: "research.complete", fact_ref: { tenantId, scope: "project", projectId, key } });
    expect(JSON.stringify(persisted.rows[0]?.fact_ref)).not.toContain(liveValue);

    const ref = persisted.rows[0]?.fact_ref;
    const resolved = await memory.resolve(
      { connectionString: connectionString! },
      { tenantId: String(ref?.tenantId), roleId: toRoleId, projectId: String(ref?.projectId) },
      String(ref?.key),
    );
    expect(resolved?.value).toBe(liveValue);
  });
});

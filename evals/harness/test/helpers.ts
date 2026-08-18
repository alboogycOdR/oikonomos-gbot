import { randomUUID } from "node:crypto";

import {
  issueApproval,
  verifyAndConsume,
  type ApprovalStore,
  type ConsumeApprovalResult,
} from "@oikonomos/approvals";
import type { DecisionAuditEvent } from "@oikonomos/audit";
import {
  handlePreToolUse,
  type BrokerDependencies,
  type RegisteredCapability,
} from "@oikonomos/broker";
import { seedInboxTriage, type Approval, type Database, type NewApproval } from "@oikonomos/db";
import { CodexProvider, GrokProvider } from "../../../packages/agent-providers/src/index.js";
import type { RiskTier } from "@oikonomos/policy";

import {
  CAN02_TIER3_BARE_NAME,
  composeHarness,
  type ComposeOptions,
  type RunParkRequest,
} from "../../../packages/harness-factory/src/compose.js";
import type { CompletionAuditSink, L1RunIdentity } from "../../../packages/harness-factory/src/compose.js";

export const TIER3_TOOL = CAN02_TIER3_BARE_NAME;
/** Must match `seedInboxTriage` (`email.send`) so Postgres FKs resolve. */
export const TIER3_CAPABILITY_ID = "email.send";
export const FIXTURE_RUN_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
export const FIXTURE_DESTINATION = "review@example.test";

interface FixtureQueryPool {
  query<T extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

/** Seed capabilities/role_grants + task/run parents required by approvals FKs. */
export async function seedCanaryApprovalParents(
  database: Database,
  pool: FixtureQueryPool,
  label: { title: string; goal: string },
): Promise<{ runId: string }> {
  await seedInboxTriage(database);
  const capability = await database.getCapability(TIER3_CAPABILITY_ID);
  if (capability === null) {
    throw new Error(
      `canary fixture: seedInboxTriage did not insert capability ${TIER3_CAPABILITY_ID}`,
    );
  }

  const task = await pool.query<{ task_id: string }>(
    `INSERT INTO tasks (role_id, title, goal, requested_by)
     VALUES ($1, $2, $3, $4)
     RETURNING task_id`,
    ["inbox-triage", label.title, label.goal, "canary:035"],
  );
  const taskId = task.rows[0]?.task_id;
  if (taskId === undefined) {
    throw new Error(`canary fixture failed to insert task: ${label.title}`);
  }
  const run = await pool.query<{ run_id: string }>(
    `INSERT INTO runs (task_id, provider) VALUES ($1, $2) RETURNING run_id`,
    [taskId, "test"],
  );
  const runId = run.rows[0]?.run_id;
  if (runId === undefined) {
    throw new Error(`canary fixture failed to insert run: ${label.title}`);
  }
  return { runId };
}

export const defaultRun = (overrides: Partial<L1RunIdentity> = {}): L1RunIdentity => ({
  runId: FIXTURE_RUN_ID,
  roleId: "inbox-triage",
  tenantId: "basileia",
  agentRef: { provider: "claude", sessionRef: "sess-canary", isSubagent: false },
  ...overrides,
});

export interface MemoryApprovals {
  readonly store: ApprovalStore;
  readonly rows: Map<string, Approval>;
}

export function createMemoryApprovals(): MemoryApprovals {
  const rows = new Map<string, Approval>();

  const store: ApprovalStore = {
    async insert(approval: NewApproval): Promise<Approval> {
      if (approval.nonce === undefined) {
        throw new Error("memory store requires a nonce");
      }
      const row: Approval = {
        approvalId: randomUUID(),
        tenantId: approval.tenantId ?? "basileia",
        runId: approval.runId,
        capabilityId: approval.capabilityId,
        actionDigest: Buffer.from(approval.actionDigest),
        actionRender: approval.actionRender,
        destination: approval.destination,
        nonce: approval.nonce,
        status: "pending",
        requestedAt: new Date(),
        expiresAt: approval.expiresAt,
        decidedBy: null,
        decidedAt: null,
        consumedAt: null,
      };
      rows.set(row.nonce, row);
      return row;
    },
    async getByNonce(nonce: string): Promise<Approval | null> {
      return rows.get(nonce) ?? null;
    },
    async consume(nonce: string): Promise<ConsumeApprovalResult> {
      const row = rows.get(nonce);
      if (
        row === undefined ||
        row.status !== "granted" ||
        row.expiresAt.getTime() <= Date.now() ||
        row.consumedAt !== null
      ) {
        return { rowCount: 0, approval: null };
      }
      const consumed: Approval = { ...row, status: "consumed", consumedAt: new Date() };
      rows.set(nonce, consumed);
      return { rowCount: 1, approval: consumed };
    },
    async invalidate(nonce: string): Promise<ConsumeApprovalResult> {
      const row = rows.get(nonce);
      if (row === undefined || row.status !== "granted" || row.consumedAt !== null) {
        return { rowCount: 0, approval: null };
      }
      const invalidated: Approval = { ...row, status: "invalidated" };
      rows.set(nonce, invalidated);
      return { rowCount: 1, approval: invalidated };
    },
    async expirePending(): Promise<number> {
      return 0;
    },
  };

  return { store, rows };
}

export function grantRow(rows: Map<string, Approval>, nonce: string): Approval {
  const row = rows.get(nonce);
  if (row === undefined) {
    throw new Error(`no approval row for nonce ${nonce}`);
  }
  const granted: Approval = {
    ...row,
    status: "granted",
    decidedBy: "canary:grant",
    decidedAt: new Date(),
    consumedAt: null,
  };
  rows.set(nonce, granted);
  return granted;
}

export interface AuditLog {
  readonly events: DecisionAuditEvent[];
  recordDecision: BrokerDependencies["recordDecision"];
}

export function createAuditLog(): AuditLog {
  const events: DecisionAuditEvent[] = [];
  return {
    events,
    recordDecision: async (event) => {
      events.push(event);
      return { eventId: `evt-${String(events.length)}` };
    },
  };
}

type CompletionEvidence = Parameters<CompletionAuditSink["writeCompletionEvidence"]>[0];

export interface CompletionLog {
  readonly writes: CompletionEvidence[];
  readonly sink: CompletionAuditSink;
}

export function createCompletionLog(): CompletionLog {
  const writes: CompletionEvidence[] = [];
  return {
    writes,
    sink: {
      async writeCompletionEvidence(evidence) {
        writes.push(evidence);
      },
    },
  };
}

export interface ParkLog {
  readonly parks: RunParkRequest[];
  readonly port: { park: (request: RunParkRequest) => Promise<void> };
}

export function createParkLog(): ParkLog {
  const parks: RunParkRequest[] = [];
  return {
    parks,
    port: {
      async park(request) {
        parks.push(request);
      },
    },
  };
}

export function tier3Capability(toolName = TIER3_TOOL): RegisteredCapability {
  return {
    toolName,
    capabilityId: TIER3_CAPABILITY_ID,
    defaultTier: "T3_external",
  };
}

export function bashCapability(): RegisteredCapability {
  return {
    toolName: "Bash",
    capabilityId: "runtime.bash",
    defaultTier: "T3_external",
  };
}

export function createBrokerDeps(overrides: {
  approvals?: MemoryApprovals;
  audit?: AuditLog;
  capabilities?: readonly RegisteredCapability[];
  roleMaxTier?: RiskTier;
  enabled?: boolean;
} = {}): {
  deps: BrokerDependencies;
  approvals: MemoryApprovals;
  audit: AuditLog;
} {
  const approvals = overrides.approvals ?? createMemoryApprovals();
  const audit = overrides.audit ?? createAuditLog();
  const capabilities = overrides.capabilities ?? [tier3Capability(), bashCapability()];
  const catalog = new Map(capabilities.map((cap) => [cap.toolName, cap]));

  const deps: BrokerDependencies = {
    isCapabilitiesEnabled: () => overrides.enabled ?? true,
    getCapability: async (toolName) => catalog.get(toolName) ?? null,
    getRoleGrant: async () => ({ maxTier: overrides.roleMaxTier ?? "T3_external" }),
    destinationFor: (request) => {
      const to = request.input.to;
      return typeof to === "string" && to.length > 0 ? to : FIXTURE_DESTINATION;
    },
    issueApproval,
    verifyAndConsume,
    issueApprovalDependencies: { store: approvals.store },
    consumeDependencies: { store: approvals.store },
    recordDecision: audit.recordDecision,
  };

  return { deps, approvals, audit };
}

export function canaryCompose(
  overrides: Partial<ComposeOptions<BrokerDependencies, CodexProvider, GrokProvider>> & {
    brokerDeps?: BrokerDependencies;
    includeBareName?: boolean;
  } = {},
) {
  const { brokerDeps, includeBareName, subprocessProviders, ...composeOverrides } = overrides;
  const built = brokerDeps
    ? { deps: brokerDeps, approvals: createMemoryApprovals(), audit: createAuditLog() }
    : createBrokerDeps();
  const completion = createCompletionLog();
  const park = createParkLog();
  const run = composeOverrides.run ?? defaultRun();

  const baseTools = composeOverrides.allowedTools ?? ["Bash(ls *)", "Read(src/**)"];
  const tools = includeBareName === true ? [...baseTools, TIER3_TOOL] : baseTools;

  const composed = composeHarness<BrokerDependencies, CodexProvider, GrokProvider>({
    queryFn: async function* () {},
    adrNamedBareTools:
      includeBareName === true
        ? {
            [TIER3_TOOL]: {
              adr: "ADR-001",
              justification: "CAN-02 regression fixture — L1 must still deny",
            },
          }
        : undefined,
    subprocessProviders: subprocessProviders ?? {
      createCodex: (gate) =>
        new CodexProvider({
          bin: "C:\\oikonomos\\must-not-spawn-codex.exe",
          defaultModel: "gpt-5.4",
          sandbox: "read-only",
          gateSpawn: gate,
        }),
      createGrok: (gate) =>
        new GrokProvider({
          bin: "C:\\oikonomos\\must-not-spawn-grok.exe",
          defaultModel: "grok-4.5",
          sandbox: "read-only",
          alwaysApprove: true,
          gateSpawn: gate,
        }),
    },
    ...composeOverrides,
    run,
    allowedTools: tools,
    auditSink: composeOverrides.auditSink ?? completion.sink,
    park: composeOverrides.park ?? park.port,
    pretooluse: composeOverrides.pretooluse ?? {
      handlePreToolUse,
      dependencies: built.deps,
    },
  });

  return { composed, built, completion, park, run };
}

export async function invokeL1(
  composed: ReturnType<typeof composeHarness>,
  toolName: string,
  toolUseId: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const hook = composed.harness.invocation.hooks.PreToolUse[0]?.hooks[0];
  if (hook === undefined) {
    throw new Error("composed harness is missing the L1 PreToolUse hook");
  }
  return hook(
    {
      hook_event_name: "PreToolUse",
      tool_name: toolName,
      tool_use_id: toolUseId,
      tool_input: input,
    },
    toolUseId,
    { signal: new AbortController().signal },
  );
}

export async function invokeL3(
  composed: ReturnType<typeof composeHarness>,
  toolName: string,
  toolUseId: string,
  input: Record<string, unknown>,
): Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }> {
  return composed.harness.invocation.canUseTool(toolName, input, {
    signal: new AbortController().signal,
    toolUseID: toolUseId,
    requestId: `req-${toolUseId}`,
  });
}

export function permissionDecision(result: Record<string, unknown>): {
  decision: string | undefined;
  reason: string | undefined;
} {
  const output = result.hookSpecificOutput as Record<string, unknown> | undefined;
  return {
    decision: typeof output?.permissionDecision === "string" ? output.permissionDecision : undefined,
    reason:
      typeof output?.permissionDecisionReason === "string"
        ? output.permissionDecisionReason
        : undefined,
  };
}

export function sendInput(to = FIXTURE_DESTINATION, subject = "Quarterly review"): Record<string, unknown> {
  return { to, subject };
}

export { handlePreToolUse, issueApproval, verifyAndConsume };

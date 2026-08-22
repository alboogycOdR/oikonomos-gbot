import type { Writable } from "node:stream";

import Fastify, { type FastifyInstance } from "fastify";
import { runStatuses, type Approval, type RunStatus } from "@oikonomos/db";

import { getOpenApiDocument } from "./openapi.js";
import { redactApprovalNonceFromUrl } from "./redact.js";
import type { ControlApiDeps } from "./ports.js";

export interface BuildAppOptions {
  /** `false` disables logging entirely (route tests default to this). */
  logger?: boolean;
  /**
   * Test-only hook: capture the real pino output stream instead of
   * stdout, so a test can assert on emitted log lines directly (N4
   * redaction proof) without parsing stdout.
   */
  logStream?: Writable;
}

const NEW_TASK_SCHEMA = {
  type: "object",
  required: ["roleId", "title", "goal", "requestedBy"],
  additionalProperties: false,
  properties: {
    tenantId: { type: "string" },
    roleId: { type: "string" },
    title: { type: "string" },
    goal: { type: "string" },
    routineId: { type: "string" },
    requestedBy: { type: "string" },
  },
} as const;

const LIST_RUNS_QUERY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    tenantId: { type: "string" },
    status: { type: "string" },
    taskId: { type: "string" },
    limit: { type: "integer" },
    cursor: { type: "string" },
  },
} as const;

const LIST_APPROVALS_QUERY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    tenantId: { type: "string" },
  },
} as const;

const DECIDE_APPROVAL_SCHEMA = {
  type: "object",
  required: ["decision", "decidedBy"],
  additionalProperties: false,
  properties: {
    decision: { type: "string", enum: ["granted", "rejected"] },
    decidedBy: { type: "string" },
  },
} as const;

/**
 * Approvals carry `actionDigest` as a `Buffer`; JSON.stringify on a raw
 * Buffer produces `{ type: "Buffer", data: [...] }`, which is not a
 * useful wire format. Serialize it as base64 instead.
 */
function serializeApproval(approval: Approval): Record<string, unknown> {
  return {
    ...approval,
    actionDigest: Buffer.from(approval.actionDigest).toString("base64"),
  };
}

function isRunStatus(value: string): value is RunStatus {
  return (runStatuses as readonly string[]).includes(value);
}

/**
 * Build the control-api Fastify instance against an injected
 * `ControlApiDeps` port (OIK-084: this file never imports `pg` or
 * `@oikonomos/db`'s `Pool`-holding internals — only the port). Route
 * tests inject a fake port; `index.ts#start` and the DATABASE_URL-gated
 * integration tests inject `createDatabaseBackedDeps(...)`.
 */
export function buildApp(deps: ControlApiDeps, options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: "info",
            stream: options.logStream,
            serializers: {
              req(request: { method: string; url: string; hostname?: string }) {
                return {
                  method: request.method,
                  url: redactApprovalNonceFromUrl(request.url),
                  hostname: request.hostname,
                };
              },
            },
          },
  });

  app.get("/openapi.json", async () => getOpenApiDocument());

  app.post<{ Body: Record<string, unknown> }>(
    "/tasks",
    { schema: { body: NEW_TASK_SCHEMA } },
    async (request, reply) => {
      const body = request.body as {
        tenantId?: string;
        roleId: string;
        title: string;
        goal: string;
        routineId?: string;
        requestedBy: string;
      };
      try {
        const task = await deps.createTask(body);
        await reply.code(201).send(task);
      } catch (error) {
        await reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  app.get<{
    Querystring: { tenantId?: string; status?: string; taskId?: string; limit?: number; cursor?: string };
  }>("/runs", { schema: { querystring: LIST_RUNS_QUERY_SCHEMA } }, async (request, reply) => {
    try {
      const { tenantId, status, taskId, limit, cursor } = request.query;
      if (status !== undefined && !isRunStatus(status)) {
        await reply.code(400).send({ error: `status must be one of ${runStatuses.join(", ")}.` });
        return;
      }
      const page = await deps.listRuns({
        ...(tenantId !== undefined && { tenantId }),
        ...(status !== undefined && { status }),
        ...(taskId !== undefined && { taskId }),
        ...(limit !== undefined && { limit }),
        ...(cursor !== undefined && { cursor }),
      });
      await reply.code(200).send(page);
    } catch (error) {
      await reply.code(400).send({ error: (error as Error).message });
    }
  });

  app.get<{ Params: { id: string } }>("/runs/:id", async (request, reply) => {
    try {
      const run = await deps.getRun(request.params.id);
      if (run === null) {
        await reply.code(404).send({ error: "run not found" });
        return;
      }
      await reply.code(200).send(run);
    } catch (error) {
      await reply.code(400).send({ error: (error as Error).message });
    }
  });

  app.get<{ Params: { id: string } }>("/runs/:id/evidence", async (request, reply) => {
    try {
      const events = await deps.getAuditEventsForRun(request.params.id);
      await reply.code(200).send(events);
    } catch (error) {
      await reply.code(400).send({ error: (error as Error).message });
    }
  });

  app.get<{ Querystring: { tenantId?: string } }>(
    "/approvals",
    { schema: { querystring: LIST_APPROVALS_QUERY_SCHEMA } },
    async (request, reply) => {
      try {
        const { tenantId } = request.query;
        const approvals = await deps.listPendingApprovals(tenantId !== undefined ? { tenantId } : {});
        await reply.code(200).send(approvals.map(serializeApproval));
      } catch (error) {
        await reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  app.post<{ Params: { nonce: string }; Body: { decision: "granted" | "rejected"; decidedBy: string } }>(
    "/approvals/:nonce/decide",
    { schema: { body: DECIDE_APPROVAL_SCHEMA } },
    async (request, reply) => {
      try {
        const { decision, decidedBy } = request.body;
        const result = await deps.decideApproval(request.params.nonce, decision, decidedBy);
        if (result.decided) {
          await reply.code(200).send({ decided: true, approval: serializeApproval(result.approval) });
          return;
        }
        await reply.code(409).send({ decided: false });
      } catch (error) {
        await reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  return app;
}

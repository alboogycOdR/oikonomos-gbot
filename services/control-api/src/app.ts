import type { Writable } from "node:stream";

import Fastify, { type FastifyInstance } from "fastify";
import { runStatuses, type Approval, type RunStatus } from "@oikonomos/db";
import { DEFAULT_APPROVAL_TTL_MS, type JsonValue } from "@oikonomos/approvals";

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
 * TASK-063 / ADR-004: no `render` property here — the replacement's
 * action_render is always DERIVED from {toolName, input, destination}
 * inside `packages/approvals`, never caller-supplied. `additionalProperties:
 * false` mechanically refuses a caller who tries to pass one.
 */
const EDIT_APPROVAL_SCHEMA = {
  type: "object",
  required: ["runId", "capabilityId", "toolName", "input", "destination"],
  additionalProperties: false,
  properties: {
    runId: { type: "string" },
    capabilityId: { type: "string" },
    toolName: { type: "string" },
    input: {},
    destination: { type: "string" },
    tenantId: { type: "string" },
    expiresAt: { type: "string" },
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
 * TASK-063 rework (round-1 review): a caller-supplied `expiresAt` on the
 * edit route was accepted with zero bound validation, letting a single
 * ordinary call reach the exact hazard this task's own Description
 * forbids — "invalidated with no usable replacement" — by invalidating
 * the original approval and then persisting a replacement that is
 * already expired (or, in the other direction, a caller-controlled
 * unbounded-lifetime bearer nonce). This runs BEFORE `editApproval` is
 * ever called, so a rejection here leaves the original approval
 * completely untouched — no invalidate has happened yet.
 *
 * Bound is the platform's own default approval TTL
 * (`DEFAULT_APPROVAL_TTL_MS`, `@oikonomos/approvals`'s `issue.ts`) rather
 * than a new invented constant here, per the review's instruction to
 * reuse the existing default-TTL constant. An omitted `expiresAt` is not
 * validated here at all — it is left `undefined` and `editApproval`
 * applies that same default itself.
 *
 * A value that fails to parse to a valid `Date` is intentionally NOT
 * rejected here: `editApproval`'s own `resolveExpiresAt` already throws
 * "expiresAt must be a valid Date." for that case, and the route's
 * existing catch-all maps it to 400 — duplicating that check here would
 * just be a second implementation of the same validation.
 */
function validateEditExpiresAt(expiresAt: Date, now: number): string | undefined {
  if (Number.isNaN(expiresAt.getTime())) {
    return undefined;
  }
  if (expiresAt.getTime() <= now) {
    return "expiresAt must be strictly in the future.";
  }
  if (expiresAt.getTime() > now + DEFAULT_APPROVAL_TTL_MS) {
    return `expiresAt must not exceed the platform approval TTL (${DEFAULT_APPROVAL_TTL_MS}ms from now).`;
  }
  return undefined;
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

  app.post<{
    Params: { nonce: string };
    Body: {
      runId: string;
      capabilityId: string;
      toolName: string;
      input: unknown;
      destination: string;
      tenantId?: string;
      expiresAt?: string;
    };
  }>(
    "/approvals/:nonce/edit",
    { schema: { body: EDIT_APPROVAL_SCHEMA } },
    async (request, reply) => {
      try {
        const { runId, capabilityId, toolName, input, destination, tenantId, expiresAt } = request.body;
        // TASK-063 rework AC: a caller-supplied expiresAt that is not
        // strictly in the future, or that exceeds the platform's approval
        // TTL, is rejected HERE — before editApproval is ever called — so
        // the original approval is left completely untouched on refusal.
        // Omitted expiresAt (undefined) skips this check entirely and
        // inherits editApproval's own default.
        let parsedExpiresAt: Date | undefined;
        if (expiresAt !== undefined) {
          parsedExpiresAt = new Date(expiresAt);
          const validationError = validateEditExpiresAt(parsedExpiresAt, Date.now());
          if (validationError !== undefined) {
            await reply.code(400).send({ error: validationError });
            return;
          }
        }
        // TASK-063 AC (carried forward from TASK-080 round-2 review): tenantId
        // is forwarded explicitly on EVERY call, even when undefined — an
        // omitted tenantId is a HARD REFUSAL in editApproval for any
        // non-basileia tenant's approval, so this field must never be
        // dropped while building the request passed downstream.
        const result = await deps.editApproval(request.params.nonce, {
          runId,
          capabilityId,
          toolName,
          input: input as JsonValue,
          destination,
          tenantId,
          ...(parsedExpiresAt !== undefined && { expiresAt: parsedExpiresAt }),
        });
        if (result.edited) {
          await reply.code(200).send({
            edited: true,
            invalidated: serializeApproval(result.invalidated),
            replacement: result.replacement,
          });
          return;
        }
        await reply.code(409).send({ edited: false });
      } catch (error) {
        await reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  return app;
}

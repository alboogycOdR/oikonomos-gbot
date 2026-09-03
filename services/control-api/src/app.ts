import type { Writable } from "node:stream";
import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import { runStatuses, taskStatuses, type Approval, type RunStatus, type TaskStatus } from "@oikonomos/db";
import { DEFAULT_APPROVAL_TTL_MS, type JsonValue } from "@oikonomos/approvals";

import { getOpenApiDocument } from "./openapi.js";
import { redactApprovalNonceFromUrl } from "./redact.js";
import type { ControlApiDeps } from "./ports.js";
import {
  buildExpiredSessionCookie,
  buildSessionCookie,
  createSessionToken,
  isAuthorized,
  isValidLoginToken,
} from "./auth.js";

export interface BuildAppOptions {
  /** `false` disables logging entirely (route tests default to this). */
  logger?: boolean;
  /**
   * Test-only hook: capture the real pino output stream instead of
   * stdout, so a test can assert on emitted log lines directly (N4
   * redaction proof) without parsing stdout.
   */
  logStream?: Writable;
  /**
   * TASK-101: the shared secret gating every route except `POST
   * /auth/login` and `GET /openapi.json`. Falls back to
   * `process.env.CONTROL_API_TOKEN` when omitted (so `index.ts#start` —
   * outside this task's Owned_Paths — needs no changes to pick up the
   * gate). Whichever value is used, a blank/whitespace-only result is
   * rejected at build time: fail closed (N3) — a service that cannot
   * authenticate must refuse to start, never silently serve every route
   * unauthenticated.
   */
  authToken?: string;
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

const LIST_TASKS_QUERY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    tenantId: { type: "string" },
    status: { type: "string" },
    limit: { type: "integer" },
    cursor: { type: "string" },
  },
} as const;

const LOGIN_SCHEMA = {
  type: "object",
  required: ["token"],
  additionalProperties: false,
  properties: {
    token: { type: "string" },
  },
} as const;

const CREATE_ROLE_SCHEMA = {
  type: "object",
  required: ["name", "description"],
  additionalProperties: false,
  properties: { name: { type: "string" }, description: { type: "string" } },
} as const;

const CREATE_THREAD_SCHEMA = {
  type: "object",
  required: ["roleId"],
  additionalProperties: false,
  properties: { roleId: { type: "string" } },
} as const;

const CREATE_MESSAGE_SCHEMA = {
  type: "object",
  required: ["body"],
  additionalProperties: false,
  properties: { body: { type: "string" } },
} as const;

const LIST_MESSAGES_QUERY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { after: { type: "string" } },
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
 * useful wire format. `bigint` values cannot be JSON-serialized at all.
 * Serialize the digest as base64 and the optional context epoch as a decimal
 * string instead.
 */
function serializeApproval(approval: Approval): Record<string, unknown> {
  return {
    ...approval,
    actionDigest: Buffer.from(approval.actionDigest).toString("base64"),
    userContextEpoch:
      approval.userContextEpoch === null || approval.userContextEpoch === undefined
        ? null
        : approval.userContextEpoch.toString(),
  };
}

function serializeRole(role: { roleId: string; name: string; description: string }) {
  return { id: role.roleId, name: role.name, description: role.description, avatarSeed: role.roleId };
}

function isRunStatus(value: string): value is RunStatus {
  return (runStatuses as readonly string[]).includes(value);
}

function isTaskStatus(value: string): value is TaskStatus {
  return (taskStatuses as readonly string[]).includes(value);
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
  const resolvedAuthToken = options.authToken ?? process.env.CONTROL_API_TOKEN ?? "";
  if (resolvedAuthToken.trim().length === 0) {
    // Fail closed (N3): a service that cannot authenticate must refuse
    // to start rather than silently serve every route unauthenticated.
    throw new Error(
      "control-api requires an auth token: pass BuildAppOptions.authToken or set CONTROL_API_TOKEN.",
    );
  }
  const authToken = resolvedAuthToken;

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

  // TASK-101: global fail-closed auth gate. Runs as a preHandler (after
  // routing, so `routeOptions.config` is populated) for every route
  // except the two explicitly marked `public: true` below. A route that
  // does not exist never reaches this hook at all (Fastify 404s first),
  // which is fine — there is nothing to protect on a 404.
  app.addHook("preHandler", async (request, reply) => {
    const config = request.routeOptions.config as { public?: boolean } | undefined;
    if (config?.public === true) {
      return;
    }
    if (isAuthorized({ authorization: request.headers.authorization, cookie: request.headers.cookie }, authToken)) {
      return;
    }
    await reply.code(401).send({ error: "unauthorized" });
  });

  // TASK-101: `openapi.ts` is outside this task's Owned_Paths, so the new
  // `/auth/login` and `GET /tasks` documentation is merged onto the base
  // document here at serve time rather than editing that file. This keeps
  // `GET /openapi.json` describing every live route (AC #4's "same
  // OpenAPI-document pattern") without an out-of-territory edit.
  app.get("/openapi.json", { config: { public: true } }, async () => {
    const base = getOpenApiDocument() as {
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    return {
      ...base,
      paths: {
        ...base.paths,
        "/auth/login": {
          post: {
            summary: "Exchange the shared CONTROL_API_TOKEN for a session cookie (TASK-101)",
            operationId: "login",
            requestBody: {
              required: true,
              content: { "application/json": { schema: { $ref: "#/components/schemas/LoginRequest" } } },
            },
            responses: {
              "200": { description: "Session cookie issued" },
              "401": { description: "Invalid token" },
            },
          },
        },
        "/tasks": {
          ...(base.paths["/tasks"] as Record<string, unknown>),
          get: {
            summary: "List tasks",
            operationId: "listTasks",
            parameters: [
              { name: "tenantId", in: "query", schema: { type: "string" } },
              { name: "status", in: "query", schema: { type: "string" } },
              { name: "limit", in: "query", schema: { type: "integer" } },
              { name: "cursor", in: "query", schema: { type: "string" } },
            ],
            responses: {
              "200": {
                description: "A page of tasks, newest-first",
                content: { "application/json": { schema: { $ref: "#/components/schemas/TaskListPage" } } },
              },
            },
          },
        },
        "/roles": {
          get: { summary: "List chat bots", operationId: "listRoles", responses: { "200": { description: "Chat bots" } } },
          post: { summary: "Create a chat bot", operationId: "createRole", responses: { "201": { description: "Chat bot created" } } },
        },
        "/threads": {
          get: { summary: "List chat threads", operationId: "listThreads", responses: { "200": { description: "Chat threads" } } },
          post: { summary: "Create or return a chat thread", operationId: "createThread", responses: { "201": { description: "Chat thread" } } },
        },
        "/threads/{id}/messages": {
          get: { summary: "List a chat transcript", operationId: "listThreadMessages", responses: { "200": { description: "Transcript messages" } } },
          post: { summary: "Post a chat message", operationId: "createThreadMessage", responses: { "201": { description: "User message created" } } },
        },
      },
      components: {
        ...base.components,
        schemas: {
          ...base.components.schemas,
          LoginRequest: {
            type: "object",
            required: ["token"],
            properties: { token: { type: "string" } },
          },
          TaskListPage: {
            type: "object",
            properties: {
              tasks: { type: "array", items: { $ref: "#/components/schemas/Task" } },
              nextCursor: { type: "string", nullable: true },
            },
          },
        },
      },
    };
  });

  app.post<{ Body: { token: string } }>(
    "/auth/login",
    { config: { public: true }, schema: { body: LOGIN_SCHEMA } },
    async (request, reply) => {
      const { token } = request.body;
      if (!isValidLoginToken(token, authToken)) {
        await reply.code(401).send({ error: "invalid token" });
        return;
      }
      const session = createSessionToken(authToken);
      await reply.header("set-cookie", buildSessionCookie(session)).code(200).send({ authenticated: true });
    },
  );

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

  app.get("/roles", async (_request, reply) => {
    try {
      const roles = await deps.listRoles({ tenantId: "basileia", status: "active" });
      await reply.code(200).send(roles.map(serializeRole));
    } catch (error) {
      await reply.code(400).send({ error: (error as Error).message });
    }
  });

  app.post<{ Body: { name: string; description: string } }>(
    "/roles",
    { schema: { body: CREATE_ROLE_SCHEMA } },
    async (request, reply) => {
      try {
        const name = request.body.name.trim();
        const description = request.body.description.trim();
        if (name.length === 0) {
          await reply.code(400).send({ error: "name must not be empty." });
          return;
        }
        const role = await deps.createRole({
          roleId: randomUUID(),
          tenantId: "basileia",
          name,
          title: name,
          description,
        });
        // Deliberately no role_grants write: a new chat bot begins fail-closed.
        await reply.code(201).send(serializeRole(role));
      } catch (error) {
        await reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  app.get("/threads", async (_request, reply) => {
    try {
      const [threads, roles] = await Promise.all([
        deps.listThreads(),
        deps.listRoles({ tenantId: "basileia", status: "active" }),
      ]);
      const rolesById = new Map(roles.map((role) => [role.roleId, role]));
      const result = await Promise.all(
        threads.map(async (thread) => {
          const messages = await deps.listMessages(thread.id);
          const lastMessage = messages.at(-1);
          const role = rolesById.get(thread.roleId);
          return {
            id: thread.id,
            roleId: thread.roleId,
            botName: role?.name ?? thread.roleId,
            botDescription: role?.description ?? "",
            avatarSeed: thread.roleId,
            title: thread.title,
            lastMessagePreview: lastMessage?.body ?? "",
            updatedAt: thread.updatedAt,
          };
        }),
      );
      await reply.code(200).send(result);
    } catch (error) {
      await reply.code(400).send({ error: (error as Error).message });
    }
  });

  app.post<{ Body: { roleId: string } }>(
    "/threads",
    { schema: { body: CREATE_THREAD_SCHEMA } },
    async (request, reply) => {
      try {
        const thread = await deps.getOrCreateThreadForRole({ roleId: request.body.roleId });
        await reply.code(201).send(thread);
      } catch (error) {
        await reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    "/threads/:id/messages",
    { schema: { querystring: LIST_MESSAGES_QUERY_SCHEMA } },
    async (request, reply) => {
      try {
        const messages = await deps.listMessages(request.params.id, request.query.after === undefined ? {} : { after: request.query.after });
        const approvals = await deps.listPendingApprovals();
        const approvalsByRunId = new Map(approvals.map((approval) => [approval.runId, approval]));
        await reply.code(200).send(
          messages.map((message) => {
            const approval = message.runId === null ? undefined : approvalsByRunId.get(message.runId);
            return {
              ...message,
              ...(approval === undefined
                ? {}
                : { approval: { nonce: approval.nonce, action_render: approval.actionRender, status: approval.status } }),
            };
          }),
        );
      } catch (error) {
        await reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { body: string } }>(
    "/threads/:id/messages",
    { schema: { body: CREATE_MESSAGE_SCHEMA } },
    async (request, reply) => {
      try {
        const body = request.body.body.trim();
        if (body.length === 0) {
          await reply.code(400).send({ error: "body must not be empty." });
          return;
        }
        const thread = (await deps.listThreads()).find((candidate) => candidate.id === request.params.id);
        if (thread === undefined) {
          await reply.code(404).send({ error: "thread not found" });
          return;
        }
        const message = await deps.insertMessage({ threadId: thread.id, role: "user", body });
        const task = await deps.createTask({
          roleId: thread.roleId,
          title: `Chat: ${body.slice(0, 120)}`,
          goal: body,
          requestedBy: `chat:thread:${thread.id}`,
        });
        void deps.runChatTask({ task, threadId: thread.id }).catch((error: unknown) => {
          request.log.error(error, "chat run failed after message acceptance");
        });
        await reply.code(201).send(message);
      } catch (error) {
        await reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  app.get<{
    Querystring: { tenantId?: string; status?: string; limit?: number; cursor?: string };
  }>("/tasks", { schema: { querystring: LIST_TASKS_QUERY_SCHEMA } }, async (request, reply) => {
    try {
      const { tenantId, status, limit, cursor } = request.query;
      if (status !== undefined && !isTaskStatus(status)) {
        await reply.code(400).send({ error: `status must be one of ${taskStatuses.join(", ")}.` });
        return;
      }
      const page = await deps.listTasks({
        ...(tenantId !== undefined && { tenantId }),
        ...(status !== undefined && { status }),
        ...(limit !== undefined && { limit }),
        ...(cursor !== undefined && { cursor }),
      });
      await reply.code(200).send(page);
    } catch (error) {
      await reply.code(400).send({ error: (error as Error).message });
    }
  });

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

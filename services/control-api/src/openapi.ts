/**
 * TASK-056 / OIK-084 — "OpenAPI spec published; all surfaces consume
 * this, not the DB." Hand-authored rather than reflected from route
 * schemas: the document is small, stable, and this way it's reviewable
 * as plain data. `getOpenApiDocument()` is the single source served at
 * `GET /openapi.json`; keep it in lockstep with `app.ts`'s routes —
 * `test/app.test.ts` asserts every registered route appears here.
 */
export function getOpenApiDocument(): Record<string, unknown> {
  return {
    openapi: "3.0.3",
    info: {
      title: "OIKONOMOS control-api",
      version: "0.0.0",
      description:
        "Tasks, runs, approvals and evidence — the only surface that talks to the DB (OIK-084). Telegram and other clients consume this API, never packages/db directly.",
    },
    paths: {
      "/tasks": {
        post: {
          summary: "Create a task",
          operationId: "createTask",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/NewTask" },
              },
            },
          },
          responses: {
            "201": {
              description: "Task created",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Task" } } },
            },
            "400": { description: "Invalid task input" },
          },
        },
      },
      "/runs": {
        get: {
          summary: "List runs",
          operationId: "listRuns",
          parameters: [
            { name: "tenantId", in: "query", schema: { type: "string" } },
            { name: "status", in: "query", schema: { type: "string" } },
            { name: "taskId", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer" } },
            { name: "cursor", in: "query", schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "A page of runs, newest-first",
              content: { "application/json": { schema: { $ref: "#/components/schemas/RunListPage" } } },
            },
          },
        },
      },
      "/runs/{id}": {
        get: {
          summary: "Get one run",
          operationId: "getRun",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "The run",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Run" } } },
            },
            "404": { description: "No run with that id" },
          },
        },
      },
      "/runs/{id}/evidence": {
        get: {
          summary: "List a run's audit-trail evidence, oldest-first",
          operationId: "getRunEvidence",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "Audit events for the run",
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/components/schemas/AuditEvent" } },
                },
              },
            },
          },
        },
      },
      "/approvals": {
        get: {
          summary: "List pending approvals",
          operationId: "listApprovals",
          parameters: [{ name: "tenantId", in: "query", schema: { type: "string" } }],
          responses: {
            "200": {
              description: "Pending approvals, oldest-requested first",
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/components/schemas/Approval" } },
                },
              },
            },
          },
        },
      },
      "/approvals/{nonce}/decide": {
        post: {
          summary: "Approve or reject a pending approval (N8: single-use, atomic)",
          operationId: "decideApproval",
          parameters: [{ name: "nonce", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/DecideApprovalRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Decision applied",
              content: { "application/json": { schema: { $ref: "#/components/schemas/DecideApprovalResponse" } } },
            },
            "409": {
              description: "Decision did not apply (already decided, expired, invalidated, or unknown nonce)",
              content: { "application/json": { schema: { $ref: "#/components/schemas/DecideApprovalResponse" } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        NewTask: {
          type: "object",
          required: ["roleId", "title", "goal", "requestedBy"],
          properties: {
            tenantId: { type: "string" },
            roleId: { type: "string" },
            title: { type: "string" },
            goal: { type: "string" },
            routineId: { type: "string", nullable: true },
            requestedBy: { type: "string" },
          },
        },
        Task: { type: "object" },
        Run: { type: "object" },
        RunListPage: {
          type: "object",
          properties: {
            runs: { type: "array", items: { $ref: "#/components/schemas/Run" } },
            nextCursor: { type: "string", nullable: true },
          },
        },
        AuditEvent: { type: "object" },
        Approval: { type: "object" },
        DecideApprovalRequest: {
          type: "object",
          required: ["decision", "decidedBy"],
          properties: {
            decision: { type: "string", enum: ["granted", "rejected"] },
            decidedBy: { type: "string" },
          },
        },
        DecideApprovalResponse: {
          type: "object",
          required: ["decided"],
          properties: {
            decided: { type: "boolean" },
            approval: { $ref: "#/components/schemas/Approval" },
          },
        },
      },
    },
  };
}

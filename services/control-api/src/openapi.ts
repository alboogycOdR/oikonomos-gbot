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
      "/routines/{id}": {
        patch: {
          summary: "Update a routine's skill binding",
          operationId: "updateRoutineSkill",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/UpdateRoutineSkill" } } } },
          responses: {
            "200": { description: "Routine updated", content: { "application/json": { schema: { $ref: "#/components/schemas/Routine" } } } },
            "404": { description: "No routine with that id, or owned by a different tenant" },
          },
        },
      },
      "/routines/{id}/test-run": { post: { summary: "Fire a routine immediately", operationId: "testRunRoutine", responses: { "202": { description: "Test run accepted; test run performs real work" }, "404": { description: "No routine with that id" } } } },
      "/routines/{id}/pause": { post: { summary: "Pause a routine", operationId: "pauseRoutine", responses: { "200": { description: "Routine paused" }, "404": { description: "No routine with that id" } } } },
      "/routines/{id}/resume": { post: { summary: "Resume a routine", operationId: "resumeRoutine", responses: { "200": { description: "Routine resumed" }, "404": { description: "No routine with that id" } } } },
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
            "400": {
              description: "Request rejected before a decision was attempted (invalid body, or the decision failed for a reason reported as an error)",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
            },
          },
        },
      },
      "/approvals/{nonce}/edit": {
        post: {
          summary:
            "Atomically invalidate a pending approval and issue a replacement bound to the edited payload (OIK-086, ADR-004, N8)",
          operationId: "editApproval",
          parameters: [{ name: "nonce", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/EditApprovalRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Old approval invalidated; replacement issued with a new nonce and digest bound to the edited payload",
              content: { "application/json": { schema: { $ref: "#/components/schemas/EditApprovalResponse" } } },
            },
            "409": {
              description:
                "Edit did not apply (approval is not pending — already decided, expired, invalidated, or consumed — or unknown nonce)",
              content: { "application/json": { schema: { $ref: "#/components/schemas/EditApprovalResponse" } } },
            },
            "400": {
              description:
                "Request rejected before any invalidate/reissue was attempted — invalid body, an expiresAt that is not strictly in the future or exceeds the platform approval TTL, an omitted tenantId hard-refused for a non-basileia tenant, or an identity-rebind refusal. The original approval, if any, is left untouched.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
            },
          },
        },
      },
      "/skills": {
        get: {
          summary: "List skills (TASK-177, G-01b)",
          operationId: "listSkills",
          parameters: [{ name: "status", in: "query", schema: { type: "string", enum: ["active", "archived"] } }],
          responses: {
            "200": {
              description: "Skills for the caller's tenant",
              content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Skill" } } } },
            },
          },
        },
        post: {
          summary: "Create a skill",
          operationId: "createSkill",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/NewSkill" } } },
          },
          responses: {
            "201": {
              description: "Skill created",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Skill" } } },
            },
            "400": { description: "Invalid skill input" },
          },
        },
      },
      "/skills/{id}": {
        get: {
          summary: "Get one skill",
          operationId: "getSkill",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "The skill", content: { "application/json": { schema: { $ref: "#/components/schemas/Skill" } } } },
            "404": { description: "No skill with that id" },
          },
        },
        patch: {
          summary: "Update a skill",
          operationId: "updateSkill",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/UpdateSkill" } } },
          },
          responses: {
            "200": { description: "Skill updated", content: { "application/json": { schema: { $ref: "#/components/schemas/Skill" } } } },
            "404": { description: "No skill with that id" },
          },
        },
      },
      "/roles/{roleId}/skills/{skillId}": {
        put: {
          summary: "Enable or disable a skill for a chat bot (the per-Bot enable list)",
          operationId: "setRoleSkillEnabled",
          parameters: [
            { name: "roleId", in: "path", required: true, schema: { type: "string" } },
            { name: "skillId", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", required: ["enabled"], properties: { enabled: { type: "boolean" } } },
              },
            },
          },
          responses: {
            "200": { description: "Enable state applied" },
            "400": { description: "Invalid request" },
          },
        },
      },
      "/roles/{roleId}/skills": {
        get: {
          summary: "List the skills enabled for a chat bot",
          operationId: "listRoleSkills",
          parameters: [{ name: "roleId", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "Skills enabled for this bot",
              content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Skill" } } } },
            },
          },
        },
      },
      "/threads/{id}": {
        get: {
          summary: "Get a thread's context meter and 'start fresh' epoch (TASK-179, G-03a)",
          operationId: "getThreadContext",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "Thread context meter",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ThreadContext" } } },
            },
            "404": { description: "No thread with that id (or owned by a different tenant)" },
            "501": { description: "Thread context is not configured on this deployment" },
          },
        },
      },
      "/threads/{id}/fresh": {
        post: {
          summary: "'Start fresh': bump the thread's epoch (TASK-179, G-03a)",
          operationId: "startThreadFresh",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "New epoch and reset context meter",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ThreadContext" } } },
            },
            "404": { description: "No thread with that id (or owned by a different tenant)" },
            "501": { description: "Thread context is not configured on this deployment" },
          },
        },
      },
      "/secret-requests": {
        get: {
          summary: "List pending secret requests (TASK-187, G-05b)",
          operationId: "listSecretRequests",
          parameters: [{ name: "status", in: "query", schema: { type: "string", enum: ["pending"] } }],
          responses: {
            "200": {
              description: "Pending secret requests for the caller's tenant",
              content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/SecretRequest" } } } },
            },
            "400": { description: "status was not 'pending'" },
            "501": { description: "Secret requests are not configured on this deployment" },
          },
        },
      },
      "/secret-requests/{id}/fulfil": {
        post: {
          summary: "Provide the requested secret value (TASK-187, G-05b)",
          operationId: "fulfilSecretRequest",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/FulfilSecretRequest" } } },
          },
          responses: {
            "200": {
              description: "Fulfilled; only the opaque vault ref is returned, never the value",
              content: { "application/json": { schema: { $ref: "#/components/schemas/FulfilSecretRequestResponse" } } },
            },
            "400": { description: "Missing/blank value" },
            "404": { description: "No pending secret request with that id (or owned by a different tenant)" },
            "501": { description: "Secret requests are not configured on this deployment" },
          },
        },
      },
      "/secret-requests/{id}/decline": {
        post: {
          summary: "Decline a secret request (TASK-187, G-05b)",
          operationId: "declineSecretRequest",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Declined; the parked run is resumed with a model-directed refusal message" },
            "404": { description: "No pending secret request with that id (or owned by a different tenant)" },
            "501": { description: "Secret requests are not configured on this deployment" },
          },
        },
      },
    },
    components: {
      schemas: {
        SecretRequest: {
          type: "object",
          required: ["requestId", "runId", "roleId", "label", "purpose", "createdAt"],
          properties: {
            requestId: { type: "string", format: "uuid" },
            runId: { type: "string", format: "uuid" },
            roleId: { type: "string" },
            label: { type: "string" },
            purpose: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        FulfilSecretRequest: {
          type: "object",
          required: ["value"],
          properties: { value: { type: "string", minLength: 1 } },
        },
        FulfilSecretRequestResponse: {
          type: "object",
          required: ["requestId", "ref"],
          properties: {
            requestId: { type: "string" },
            ref: { type: "string", description: "Opaque sealed-vault reference; never the plaintext value." },
          },
        },
        NewSkill: {
          type: "object",
          required: ["name", "description", "body"],
          properties: {
            tenantId: { type: "string" },
            name: { type: "string", description: "The /name slash token, ^[a-z0-9][a-z0-9-]{1,63}$." },
            description: { type: "string" },
            whenToUse: { type: "string", nullable: true },
            body: { type: "string" },
            inputs: { type: "array", items: { type: "object" } },
            access: { type: "array", items: { type: "string" } },
            approvals: { type: "array", items: { type: "string" } },
            failurePolicy: { type: "object" },
            status: { type: "string", enum: ["active", "archived"] },
          },
        },
        UpdateSkill: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            whenToUse: { type: "string", nullable: true },
            body: { type: "string" },
            inputs: { type: "array", items: { type: "object" } },
            access: { type: "array", items: { type: "string" } },
            approvals: { type: "array", items: { type: "string" } },
            failurePolicy: { type: "object" },
            status: { type: "string", enum: ["active", "archived"] },
          },
        },
        Skill: { type: "object" },
        Routine: { type: "object" },
        UpdateRoutineSkill: {
          type: "object",
          required: ["skillId"],
          additionalProperties: false,
          properties: { skillId: { type: "string", format: "uuid", nullable: true } },
        },
        ThreadContext: {
          type: "object",
          required: ["id", "contextTokens", "contextLimit", "epoch"],
          properties: {
            id: { type: "string" },
            contextTokens: { type: "integer", description: "Estimated tokens in the currently assembled prompt." },
            contextLimit: { type: "integer" },
            epoch: { type: "integer", description: "Bumped by POST /threads/{id}/fresh; only the current epoch's messages/summaries are assembled into the prompt." },
          },
        },
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
        EditApprovalRequest: {
          type: "object",
          required: ["runId", "capabilityId", "toolName", "input", "destination"],
          description:
            "No 'render' field — action_render is always derived from {toolName, input, destination} inside packages/approvals (ADR-004), never caller-supplied.",
          properties: {
            runId: { type: "string" },
            capabilityId: { type: "string" },
            toolName: { type: "string" },
            input: {},
            destination: { type: "string" },
            tenantId: {
              type: "string",
              description:
                "Must match the original approval's tenant. Omitted defaults to 'basileia' and is a hard refusal for any other tenant's approval.",
            },
            expiresAt: { type: "string", format: "date-time" },
          },
        },
        EditApprovalResponse: {
          type: "object",
          required: ["edited"],
          properties: {
            edited: { type: "boolean" },
            invalidated: { $ref: "#/components/schemas/Approval" },
            replacement: { type: "object" },
          },
        },
        ErrorResponse: {
          type: "object",
          required: ["error"],
          properties: {
            error: { type: "string" },
          },
        },
      },
    },
  };
}

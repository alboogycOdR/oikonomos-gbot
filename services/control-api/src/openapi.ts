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
      "/health/ready": {
        get: {
          summary: "Database readiness for the local process supervisor",
          operationId: "readiness",
          responses: {
            "200": { description: "Database answered" },
            "503": { description: "Database is unreachable or timed out" },
          },
        },
      },
      "/threads": {
        get: {
          summary: "List tenant-owned chat threads with roster title and latest-message preview",
          operationId: "listThreads",
          responses: {
            "200": {
              description: "Chat threads",
              content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/ThreadRoster" } } } },
            },
          },
        },
        post: {
          summary: "Create or return a chat thread",
          operationId: "createThread",
          responses: { "201": { description: "Chat thread" } },
        },
      },
      "/projects": {
        post: {
          summary: "Create a project: one group thread, a roster of at most 6, at most one manager, and the charter, in one transaction (TASK-304, spec §9.1)",
          operationId: "createProject",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/NewProject" } } } },
          responses: {
            "201": { description: "Project created", content: { "application/json": { schema: { $ref: "#/components/schemas/ProjectWithRoster" } } } },
            "400": { description: "Invalid project input, roster, or a role that is not this tenant's" },
            "501": { description: "Projects are not configured" },
          },
        },
        get: {
          summary: "List this tenant's projects",
          operationId: "listProjects",
          parameters: [{ name: "status", in: "query", schema: { type: "string", enum: ["active", "paused", "done", "archived"] } }],
          responses: { "200": { description: "Projects", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Project" } } } } } },
        },
      },
      "/projects/{id}": {
        get: {
          summary: "Get a project: charter, roster, board summary, latest STATUS.md artifact, spend vs budget",
          operationId: "getProject",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: {
            "200": { description: "Project detail", content: { "application/json": { schema: { $ref: "#/components/schemas/Project" } } } },
            "404": { description: "No such project, or owned by a different tenant (never 403)" },
          },
        },
        patch: {
          summary: "Update status, budget, roster or manager; demoting a manager revokes its grants and invalidates its pending create_bot approvals in one transaction",
          operationId: "updateProject",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: {
            "200": { description: "Project updated", content: { "application/json": { schema: { $ref: "#/components/schemas/ProjectWithRoster" } } } },
            "400": { description: "Invalid update" },
            "404": { description: "No such project, or owned by a different tenant" },
          },
        },
      },
      "/projects/{id}/tasks": {
        get: {
          summary: "List the project's work items",
          operationId: "listProjectTasks",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
            { name: "state", in: "query", schema: { type: "string", enum: ["todo", "doing", "blocked", "review", "done", "cancelled"] } },
          ],
          responses: { "200": { description: "Work items" }, "404": { description: "No such project" } },
        },
        post: {
          summary: "Create a work item; blocked needs a reason and an owner must be on the roster",
          operationId: "createProjectTask",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: { "201": { description: "Work item created" }, "400": { description: "Invalid work item" }, "404": { description: "No such project" } },
        },
      },
      "/projects/{id}/tasks/{taskId}": {
        patch: {
          summary: "Transition a work item (audited) and/or reassign its owner",
          operationId: "updateProjectTask",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
            { name: "taskId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: { "200": { description: "Work item updated" }, "400": { description: "Illegal transition, missing blocked reason, or owner not on the roster" }, "404": { description: "No such project or work item" } },
        },
      },
      "/projects/{id}/artifacts": {
        get: {
          summary: "List the project's artifact register (references, never bytes)",
          operationId: "listProjectArtifacts",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Artifacts, newest first" }, "404": { description: "No such project" } },
        },
        post: {
          summary: "Register an artifact; a workspace_file ref must be a canonical path under the project directory",
          operationId: "registerProjectArtifact",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: { "201": { description: "Artifact registered" }, "400": { description: "Invalid artifact" }, "404": { description: "No such project" } },
        },
      },
      "/projects/{id}/decisions": {
        get: {
          summary: "The decision log; approvals decided on a project-attributed run appear by approval_id",
          operationId: "listProjectDecisions",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Decisions" }, "404": { description: "No such project" } },
        },
      },
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
      "/roles/{roleId}/auto-review": {
        get: { summary: "Get a bot's Auto-review switch and approval rules", operationId: "getAutoReview", responses: { "200": { description: "Auto-review state" }, "404": { description: "No such bot in this tenant" } } },
        put: { summary: "Enable or disable Auto-review for a bot", operationId: "setAutoReview", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["enabled"], properties: { enabled: { type: "boolean" } } } } } }, responses: { "200": { description: "Updated Auto-review state" }, "404": { description: "No such bot in this tenant" } } },
      },
      "/roles/{roleId}/review-rules": {
        get: { summary: "List a bot's Require-Approval rules", operationId: "listReviewRules", responses: { "200": { description: "Review rules" }, "404": { description: "No such bot in this tenant" } } },
        post: { summary: "Add a manual Require-Approval rule for a granted capability", operationId: "createReviewRule", responses: { "201": { description: "Review rule created" }, "400": { description: "Capability is not granted" } } },
      },
      "/roles/{roleId}/review-rules/{ruleId}": {
        delete: { summary: "Disable a bot review rule", operationId: "disableReviewRule", responses: { "204": { description: "Rule disabled" }, "404": { description: "No such rule or bot in this tenant" } } },
      },
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
      "/runs/{id}/receipt": {
        get: {
          summary: "Get a tenant-scoped run completion receipt",
          operationId: "getRunReceipt",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: {
            "200": {
              description: "Final result, audited actions, approvals, and recorded spend. Spend is unavailable when no ledger rows exist.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/RunReceipt" } } },
            },
            "404": { description: "No run with that id, or owned by a different tenant" },
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
      "/threads/{id}/read": {
        post: {
          summary: "Mark a tenant-owned thread read",
          operationId: "markThreadRead",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: { required: false, content: { "application/json": { schema: { type: "object", properties: { messageAt: { type: "string", format: "date-time" } } } } } },
          responses: { "200": { description: "Read marker stored" }, "404": { description: "No owned thread with that id" } },
        },
      },
      "/threads/{id}/pin": {
        put: {
          summary: "Pin a tenant-owned thread",
          operationId: "pinThread",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Pin stored" }, "404": { description: "No owned thread with that id" } },
        },
        delete: {
          summary: "Remove a tenant-owned thread pin",
          operationId: "unpinThread",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "204": { description: "Pin removed" }, "404": { description: "No owned thread with that id" } },
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
      "/runs/{id}/takeover": {
        get: {
          summary: "Whether this run is parked awaiting a human take-over, and why (TASK-188, G-07)",
          operationId: "getRunTakeover",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "Take-over state — kind/detail present only when pending",
              content: { "application/json": { schema: { $ref: "#/components/schemas/TakeoverStatus" } } },
            },
            "404": { description: "No run with that id (or owned by a different tenant)" },
            "501": { description: "Take-over is not configured on this deployment" },
          },
        },
      },
      "/runs/{id}/takeover/complete": {
        post: {
          summary: "Hand back: the human has completed the required step (TASK-188, G-07)",
          operationId: "completeRunTakeover",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Completed; the run resumes through the existing continue-after-approval path" },
            "404": { description: "No run with that id (or owned by a different tenant)" },
            "409": { description: "Not genuinely pending, or the run has no persisted session to resume — see 'reason'" },
            "501": { description: "Take-over is not configured on this deployment" },
          },
        },
      },
    },
    components: {
      schemas: {
        ThreadRoster: {
          type: "object",
          required: ["id", "title", "preview", "lastMessageAt", "updatedAt"],
          properties: {
            id: { type: "string", format: "uuid" },
            title: { type: "string", nullable: true, description: "Stored title, or the first user message shortened to about six words." },
            preview: {
              nullable: true,
              type: "object",
              required: ["text", "authorKind"],
              properties: {
                text: { type: "string", maxLength: 120, description: "Latest message with whitespace collapsed." },
                authorKind: { type: "string", enum: ["user", "bot", "system"] },
              },
            },
            lastMessageAt: { type: "string", format: "date-time", nullable: true },
            unreadCount: { type: "integer", minimum: 0 },
            pinnedAt: { type: "string", format: "date-time", nullable: true },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
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
        TakeoverStatus: {
          type: "object",
          required: ["pending"],
          properties: {
            pending: { type: "boolean" },
            kind: { type: "string", enum: ["captcha", "two_factor", "login_wall", "payment"] },
            detail: { type: "string" },
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
        Routine: {
          type: "object",
          properties: {
            // TASK-247 / §9.3: IANA time zone name used to evaluate the
            // routine's cron `schedule` and shown alongside `nextFireAt`.
            // Defaults to UTC; accepted on create via POST
            // /roles/{roleId}/routines's own (undocumented-here) body.
            timezone: { type: "string", description: "IANA time zone name used for cron evaluation and next-fire display; defaults to UTC." },
            nextFireAt: { type: "string", format: "date-time", nullable: true },
          },
        },
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
        RunReceipt: {
          type: "object",
          required: ["run", "finalMessage", "actions", "approvals", "unresolvedApprovals", "spend"],
          properties: {
            run: { $ref: "#/components/schemas/Run" },
            finalMessage: { nullable: true, type: "object" },
            actions: { type: "array", items: { $ref: "#/components/schemas/RunReceiptAction" } },
            approvals: { type: "array", items: { $ref: "#/components/schemas/RunReceiptApproval" } },
            unresolvedApprovals: { type: "array", items: { $ref: "#/components/schemas/RunReceiptApproval" } },
            spend: { $ref: "#/components/schemas/RunReceiptSpend" },
          },
        },
        RunReceiptAction: {
          type: "object",
          required: ["capability", "tier", "verdict", "reason"],
          properties: {
            capability: { type: "string", nullable: true }, tier: { type: "string", nullable: true },
            verdict: { type: "string", nullable: true }, reason: { type: "string", nullable: true },
          },
        },
        RunReceiptApproval: { type: "object" },
        RunReceiptSpend: {
          oneOf: [
            { type: "object", required: ["kind", "costUsd", "tokens"], properties: { kind: { type: "string", enum: ["actual"] }, costUsd: { type: "number" }, tokens: { type: "integer", nullable: true } } },
            { type: "object", required: ["kind"], properties: { kind: { type: "string", enum: ["unavailable"] } } },
          ],
        },
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
        NewProject: {
          type: "object",
          required: ["name", "goal", "doneCriterion", "roster"],
          properties: {
            name: { type: "string" },
            goal: { type: "string" },
            doneCriterion: { type: "string" },
            boundaries: { type: "string" },
            checkWithMeBefore: { type: "string" },
            budgetUsd: { type: "number", nullable: true },
            roster: {
              type: "array",
              minItems: 2,
              maxItems: 6,
              items: {
                type: "object",
                required: ["roleId"],
                properties: { roleId: { type: "string" }, responsibility: { type: "string" }, isManager: { type: "boolean" } },
              },
            },
          },
        },
        Project: {
          type: "object",
          required: ["projectId", "threadId", "name", "goal", "doneCriterion", "status"],
          properties: {
            projectId: { type: "string", format: "uuid" },
            threadId: { type: "string", format: "uuid" },
            name: { type: "string" },
            goal: { type: "string" },
            doneCriterion: { type: "string" },
            status: { type: "string", enum: ["active", "paused", "done", "archived"] },
            budgetUsd: { type: "number", nullable: true },
          },
        },
        ProjectWithRoster: {
          type: "object",
          required: ["project", "roster"],
          properties: {
            project: { $ref: "#/components/schemas/Project" },
            roster: { type: "array", items: { type: "object" } },
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

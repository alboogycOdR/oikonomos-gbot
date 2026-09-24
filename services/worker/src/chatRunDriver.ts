import { issueApproval, verifyAndConsume } from "@oikonomos/approvals";
import { DEFAULT_GEMINI_MODEL } from "@oikonomos/agent-providers";
import { BrokerFailure, handlePreToolUse } from "@oikonomos/broker";
import { BUILTIN_TOOLS, CapabilityRegistry, PolicyRegistry, declaredToolsFromManifest, type BrokerDependencies, type PreToolUseRequest } from "@oikonomos/broker";
import {
  createConnectorSessionPool,
  createGmailConnectorSessionMinter,
  createGoogleCalendarConnectorSessionMinter,
  createGoogleDriveConnectorSessionMinter,
  defaultManifestsDir,
  envSecretResolver,
  loadManifests,
  type ConnectorManifest,
  type ConnectorSessionPool,
  type CreateGmailConnectorSessionMinterOptions,
  type CreateGoogleCalendarConnectorSessionMinterOptions,
  type CreateGoogleDriveConnectorSessionMinterOptions,
} from "@oikonomos/connectors";
import {
  Database,
  getRun,
  getPlatformSpendUsd,
  getProjectByThreadId,
  listProjectRoleMembers,
  getRoleSandbox,
  getLatestThreadSummary,
  getOrInitThreadContext,
  getRole,
  getRoutine,
  getRoutineSpendUsd,
  insertMessage,
  insertThreadSummary,
  listEnabledForRole,
  listMessages,
  recordRunPhaseTiming,
  recordSpend,
  admitRunReservation,
  releaseRunReservation,
  resolveRoleRuntime,
  resumeRun as dbResumeRun,
  updateThreadContext,
  updateRoleSandboxState,
  upsertRoleSandbox,
  type DatabaseOptions,
  type RoleSandbox,
  type Task,
} from "@oikonomos/db";
import { mintBrokerToken, resolveBudgetGate, type BudgetGateDenyReason } from "@oikonomos/broker";
import { resolveEgressPolicy } from "@oikonomos/policy";
import { createSandboxClient, toOpenSandboxNetworkPolicy, SandboxClientError, type SandboxClient, type SandboxEndpoint, type Sandbox, type SandboxState } from "@oikonomos/sandbox-client";
import { recordAuditEvent, recordDecision } from "@oikonomos/audit";
import { executeTaskRun, type ConnectorContext } from "./executeRun.js";
import { completeTaskRun, failTaskRun, parkTaskRun, resumeInterruptedRun, startTaskRun } from "./runLifecycle.js";
import { sandboxHookEnvironment, withBudgetTap, type AgentSdkQueryFn, type BudgetTapSink } from "@oikonomos/harness-factory";
import { composeHarness, runWithChatBudget, STAGE_TWO_MAXIMUM_TOOL_TIER, type BudgetGateCheck, type McpServers, type RunParkPort } from "@oikonomos/harness-factory/compose";
import { createProjectGeminiTools, createSandboxGeminiTools, createSteelGeminiTools, createWorkspaceGeminiTools } from "./geminiToolExecutors.js";
import { withSandboxRelease } from "./sandboxReaper.js";
import { GEMINI_PROVIDER_ID, geminiTurnCostUsd, resolveGeminiBudget } from "./geminiChatRun.js";
import {
  BUDGET_READ_TIMEOUT_MS,
  DEFAULT_PLATFORM_CEILING_ZAR,
  DEFAULT_USD_TO_ZAR_RATE,
} from "./subprocessProviders.js";
import { readProfileTier } from "@oikonomos/memory";
import { assembleSystemPrompt, buildRoleSystemPrompt, type SkillResolver } from "./promptAssembly.js";
import { maybeCompact } from "./contextCompaction.js";
import { createTierZeroProvider, resolveTierZeroEnvConfig, type CreateTierZeroProviderOptions } from "./tierZeroProvider.js";
import { createChatRunWorkspace, removeChatRunWorkspace } from "./runWorkspace.js";
import { guardNavigationTarget } from "./navigationGuard.js";
import {
  combineConnectorContexts,
  isBrowserLaneGranted,
  resolveGmailMcpUrl,
  resolveGrantedBrowserConnector,
  resolveGrantedGmailConnector,
  resolveGrantedGoogleCalendarConnector,
  resolveGrantedGoogleDriveConnector,
  resolveGrantedProjectConnector,
  resolveGrantedWorkspaceConnector,
  WORKSPACE_CREATE_ROUTINE_TOOL,
  WORKSPACE_RENAME_SELF_TOOL,
  WORKSPACE_REQUEST_SECRET_TOOL,
  WORKSPACE_SEND_TO_ROLE_TOOL,
} from "./connectorResolution.js";
export { combineConnectorContexts } from "./connectorResolution.js";
export {
  CHAT_FANOUT_CAPABILITY_ID,
  deliverBotToBotMessage,
  type BotToBotMessageRequest,
  type BotToBotMessageResult,
} from "./groupFanout.js";

export interface ChatRunRequest {
  readonly task: Task;
  readonly threadId: string;
  /** Continue this persisted Agent SDK session instead of starting a new run. */
  readonly resume?: { readonly runId: string; readonly sessionRef?: string };
}
export interface ChatRunDriver { run(request: ChatRunRequest): Promise<void>; }
export interface CreateChatRunDriverOptions extends DatabaseOptions {
  readonly manifestsDir?: string;
  /** Test-only manifest seam; production always loads the validated manifest directory. */
  readonly manifests?: readonly ConnectorManifest[];
  /** Test-only Agent SDK seam; production uses the SDK's default query function. */
  readonly queryFn?: AgentSdkQueryFn;
  /** Injectable Tier-0 configuration for live context compaction. */
  readonly tierZeroProviderOptions?: Omit<CreateTierZeroProviderOptions, "db" | "runId">;
  /**
   * Test seam for connector session acquisition. Production callers leave
   * this unset and use the Gmail OAuth-backed session minter below.
   */
  readonly connectorSessionPool?: ConnectorSessionPool;
  /** Overrides for the Gmail minter's secret/OAuth ports; never logged. */
  readonly gmailSessionMinter?: Omit<CreateGmailConnectorSessionMinterOptions, "manifest">;
  /** Overrides for the Calendar minter's secret/OAuth ports; never logged. */
  readonly calendarSessionMinter?: Omit<CreateGoogleCalendarConnectorSessionMinterOptions, "manifest">;
  /** Overrides for the Drive minter's secret/OAuth ports; never logged. */
  readonly driveSessionMinter?: Omit<CreateGoogleDriveConnectorSessionMinterOptions, "manifest">;
  /** Injectable OpenSandbox seam; production constructs the authenticated client from SANDBOX_INTEGRATION_URL. */
  readonly sandboxClient?: SandboxClient;
  /** Overrides `DEFAULT_USD_TO_ZAR_RATE`; defaults to `process.env.USD_TO_ZAR_RATE`. */
  readonly usdToZarRate?: number;
  /** Overrides `DEFAULT_PLATFORM_CEILING_ZAR`. */
  readonly platformCeilingZar?: number;
  /**
   * Test-only Gemini transport seam (Fable review R2): production always
   * uses the adapter's real `fetch`; a test injects a fake one to prove
   * `executeGeminiChatRun`'s wiring — broker enforcement, the tier ceiling,
   * the budget gate, and spend attribution — without a live API call.
   */
  readonly geminiFetch?: typeof globalThis.fetch;
}

const SANDBOX_IMAGE = "oikonomos-office-base:claude-2.1.263";
/**
 * `OFFICE_BROWSER_IMAGE` (packages/harness-factory/src/browserLane.ts) has
 * no explicit version tag and is not reachable from this package anyway
 * (harness-factory's package.json "exports" only lists ".", "./compose",
 * and "./mcp" — browserLane.ts is not re-exported, and widening that map is
 * outside this task's Owned_Paths). Tagged here to match `SANDBOX_IMAGE`'s
 * own immutable-tag precedent (TASK-186's review flagged the untagged
 * reference; do not select an image by an untagged name in production).
 */
const OFFICE_BROWSER_SANDBOX_IMAGE = "oikonomos-office-browser:claude-2.1.263";

/** The base image's marker-writing wrapper; every image carries this one. */
const EGRESS_ENTRYPOINT = ["node", "/opt/oikonomos/egress-entrypoint.mjs", "tail", "-f", "/dev/null"] as const;
/**
 * office-browser's own wrapper: starts Steel on loopback, waits for its
 * health endpoint, THEN `exec`s the egress entrypoint above with the same
 * argv — so the egress marker chain `assertEgressPolicyApplied` depends on
 * is preserved exactly, with Steel already live before the CLI ever runs.
 */
const BROWSER_ENTRYPOINT = ["/opt/oikonomos/browser-entrypoint.sh", "tail", "-f", "/dev/null"] as const;

/**
 * TASK-208: the `entrypoint` sent to `createSandbox` MUST follow the image
 * actually selected, not be a single hardcoded array. OpenSandbox always
 * replaces the image's own Docker `ENTRYPOINT` with its `bootstrap.sh` and
 * runs this field as the command instead (see the call site), so pinning it
 * to the base image's wrapper meant `office-browser`'s `browser-entrypoint.sh`
 * — the only thing that starts Steel Browser — never ran in a real sandbox.
 * Found live 2026-09-07: `ps aux` inside a genuine office-browser sandbox
 * showed no Steel process at all and `steel_session_create` failed with
 * "Could not reach Steel at http://localhost:3000", after every earlier
 * layer (PATH, shellQuote, STEEL_LOCAL, image node_modules, the broker's
 * manifest registry, and the session-tool grants) was already fixed.
 *
 * Keyed on the resolved image, not on `isBrowserLaneGranted`, so an
 * `OIKONOMOS_SANDBOX_IMAGE` override gets the entrypoint its own image can
 * actually run. An unrecognized override falls back to the base wrapper:
 * every office-* image carries `egress-entrypoint.mjs`, only office-browser
 * carries `browser-entrypoint.sh`, so this is the fail-safe direction.
 */
export function sandboxEntrypointFor(image: string): readonly string[] {
  return image === OFFICE_BROWSER_SANDBOX_IMAGE ? BROWSER_ENTRYPOINT : EGRESS_ENTRYPOINT;
}

/**
 * TASK-208: office-browser runs a real Chromium, which cannot start inside
 * office-base's 500m/512Mi budget — confirmed live 2026-09-07, where Steel's
 * own API came up healthy but every `steel_session_create` failed with
 * "Browser launch timeout after 60000ms" until the box was made bigger.
 * Kept as tight as Chromium actually tolerates rather than generous: the
 * R350/month platform ceiling means an oversized default box is a real cost,
 * and only browser-granted roles pay this one.
 */
const BASE_RESOURCE_LIMITS = { cpu: "500m", memory: "512Mi" } as const;
const BROWSER_RESOURCE_LIMITS = { cpu: "2000m", memory: "2Gi" } as const;

export function sandboxResourceLimitsFor(image: string): { readonly cpu: string; readonly memory: string } {
  return image === OFFICE_BROWSER_SANDBOX_IMAGE ? BROWSER_RESOURCE_LIMITS : BASE_RESOURCE_LIMITS;
}
const SANDBOX_EXECD_TOKEN_REF = "secret://opensandbox/execd_access_token";
const SANDBOX_COMMAND_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_CLAUDE_SILENCE_TIMEOUT_MS = 180_000;
export const SANDBOX_SILENCE_EVENT_TYPE = "run.sandbox_silence_timeout";

/** TASK-338: thrown when a sandboxed Claude command emits nothing for the silence window. */
export class SandboxSilenceError extends Error {
  constructor(readonly silenceMs: number) {
    super("The bot stopped responding.");
    this.name = "SandboxSilenceError";
  }
}

export function claudeSilenceTimeoutMs(): number {
  const parsed = Number(process.env.OIK_CLAUDE_SILENCE_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CLAUDE_SILENCE_TIMEOUT_MS;
}
const SANDBOX_READY_TIMEOUT_MS = 30_000;
/**
 * TASK-296 — server-side TTL passed to `createSandbox` (OpenSandbox's own
 * `timeout`, seconds, absolute from creation). This is a BACKSTOP, not the
 * primary reaper: `sandboxReaper.ts`'s idle sweep (`DEFAULT_SANDBOX_IDLE_MS`,
 * 3 days) is what normally reclaims an unused office, and it runs far more
 * often than this window elapses. This number exists for the case the app
 * -level sweep can't reach — the whole worker process down, or a role's
 * office created and then the worker crashing before any sweep ever runs
 * again — so OpenSandbox's own reaper (`infra/sandbox/README.md:120`,
 * verified live: a sandbox created with `timeout: 120` was gone after its
 * window) eventually reclaims it regardless. Deliberately much LARGER than
 * the idle window: a role used at least once a week never has its office
 * killed out from under it by this alone, since the idle sweep would have
 * already reaped (and this TTL would already have been superseded by a
 * fresh `createSandbox` call, which reissues a fresh absolute deadline) long
 * before 14 days of total worker downtime could elapse.
 */
const SANDBOX_SERVER_SIDE_TTL_SECONDS = 14 * 24 * 60 * 60; // 14 days
const SANDBOX_MANAGED_SETTINGS_PATH = "/etc/claude-code/managed-settings.json";
// SHA-256 of infra/sandbox/images/office-base/managed-settings.json. Keep this
// paired with the image asset: stale or altered managed settings fail closed.
// Exported (not a secret — a public checksum of a settings file) so test
// fixtures can reference it instead of retyping the literal.
export const SANDBOX_MANAGED_SETTINGS_SHA256 = "886c6ad71724d395fd4600dd8cc0625df68686808409d6657fab8e9737083854";

/**
 * Local mode is deliberately opt-in. An unset or misspelled value must never
 * quietly bypass the managed sandbox hook on a production worker.
 */
export function chatExecutionMode(environment: NodeJS.ProcessEnv = process.env): "local" | "sandbox" {
  return environment.OIKONOMOS_CHAT_EXECUTION_MODE === "local" ? "local" : "sandbox";
}

/** First production chat task-to-run composition; registry resolution is declaration- and DB-backed. */
export function createChatRunDriver(options: CreateChatRunDriverOptions): ChatRunDriver {
  let gmailSessionPool = options.connectorSessionPool;
  let calendarSessionPool: ConnectorSessionPool | undefined;
  let driveSessionPool: ConnectorSessionPool | undefined;
  return {
    run: async (request) => runChatTask(options, request, {
      gmailPoolFor: (manifest) => {
        if (gmailSessionPool === undefined) {
          gmailSessionPool = createConnectorSessionPool({
            mint: createGmailConnectorSessionMinter({
              manifest,
              resolveUrl: options.gmailSessionMinter?.resolveUrl ?? resolveGmailMcpUrl,
              ...(options.gmailSessionMinter?.oauth === undefined ? {} : { oauth: options.gmailSessionMinter.oauth }),
              ...(options.gmailSessionMinter?.serverName === undefined ? {} : { serverName: options.gmailSessionMinter.serverName }),
            }),
          });
        }
        return gmailSessionPool;
      },
      calendarPoolFor: (manifest) => {
        if (calendarSessionPool === undefined) {
          calendarSessionPool = createConnectorSessionPool({
            mint: createGoogleCalendarConnectorSessionMinter({
              manifest,
              resolveUrl: options.calendarSessionMinter?.resolveUrl ?? envSecretResolver,
              oauth: options.calendarSessionMinter?.oauth ?? { resolve: envSecretResolver },
              ...(options.calendarSessionMinter?.serverName === undefined ? {} : { serverName: options.calendarSessionMinter.serverName }),
            }),
          });
        }
        return calendarSessionPool;
      },
      drivePoolFor: (manifest) => {
        if (driveSessionPool === undefined) {
          driveSessionPool = createConnectorSessionPool({
            mint: createGoogleDriveConnectorSessionMinter({
              manifest,
              resolveUrl: options.driveSessionMinter?.resolveUrl ?? envSecretResolver,
              ...(options.driveSessionMinter?.oauth === undefined ? {} : { oauth: options.driveSessionMinter.oauth }),
              ...(options.driveSessionMinter?.serverName === undefined ? {} : { serverName: options.driveSessionMinter.serverName }),
            }),
          });
        }
        return driveSessionPool;
      },
    }),
  };
}

/**
 * TASK-224 — real `SkillResolver` backing `assembleSystemPrompt`'s `/name`
 * token expansion. Fetches a role's enabled skills ONCE per run (not once
 * per token — a message referencing three skills should cost one DB round
 * trip, not three) and resolves by name from that in-memory list. A
 * `/name` matching no enabled skill correctly resolves to `null` here —
 * `assembleSystemPrompt` itself turns that into a system-visible "not
 * enabled for this bot" note rather than silently dropping it.
 */
function createSkillResolver(options: DatabaseOptions, roleId: string): SkillResolver {
  let enabledSkills: ReturnType<typeof listEnabledForRole> | undefined;
  return async (name: string) => {
    enabledSkills ??= listEnabledForRole(options, roleId);
    const skills = await enabledSkills;
    return skills.find((skill) => skill.name === name) ?? null;
  };
}

async function runChatTask(
  options: CreateChatRunDriverOptions,
  request: ChatRunRequest,
  pools: {
    readonly gmailPoolFor: (manifest: ConnectorManifest) => ConnectorSessionPool;
    readonly calendarPoolFor: (manifest: ConnectorManifest) => ConnectorSessionPool;
    readonly drivePoolFor: (manifest: ConnectorManifest) => ConnectorSessionPool;
  },
): Promise<void> {
  assertRequest(request);
  const database = new Database(options);
  let runId: string | undefined;
  // TASK-225: hoisted above the try so the catch block below (a separate
  // lexical scope from a `const` declared inside try {}) can read whichever
  // provider actually ran, for the human-takeover audit event's `actor`.
  // Stays "claude" if the run never gets far enough to resolve a role.
  let effectiveProvider: string = "claude";
  let geminiSpendRecorded = false;
  let reservationAdmitted = false;
  let noteFailureUnrecordedSpend: (() => Promise<void>) | undefined;
  // TASK-230 — per-phase latency instrumentation. Best-effort only: a
  // timing-record failure must never fail the actual run (same principle
  // as "push is additive, never load-bearing" elsewhere in this codebase).
  const phaseStart = performance.now();
  const recordTimingSafe = async (targetRunId: string | undefined, phase: string, durationMs: number): Promise<void> => {
    if (targetRunId === undefined) return;
    await recordRunPhaseTiming(options, { runId: targetRunId, phase, durationMs }).catch((error: unknown) => {
      console.error(`failed to record run phase timing (${phase}):`, error);
    });
  };
  try {
    const manifests = options.manifests ?? await loadManifests(options.manifestsDir ?? defaultManifestsDir());
    const registry = await CapabilityRegistry.build({ declared: [...BUILTIN_TOOLS, ...manifests.flatMap(declaredToolsFromManifest)], persisted: database });
    const acquiredGmailConnector = await resolveGrantedGmailConnector({
      database,
      manifests,
      roleId: request.task.roleId,
      tenantId: request.task.tenantId,
      gmailPoolFor: pools.gmailPoolFor,
    });
    const acquiredCalendarConnector = await resolveGrantedGoogleCalendarConnector({
      database,
      manifests,
      roleId: request.task.roleId,
      tenantId: request.task.tenantId,
      calendarPoolFor: pools.calendarPoolFor,
    });
    const acquiredDriveConnector = await resolveGrantedGoogleDriveConnector({
      database,
      manifests,
      roleId: request.task.roleId,
      tenantId: request.task.tenantId,
      drivePoolFor: pools.drivePoolFor,
    });
    // No pool/handle to release for the browser connector (see
    // resolveGrantedBrowserConnector's own comment on why it is not a
    // pooled, durable session like Gmail/Calendar/Drive) — it is combined
    // directly, not tracked alongside the acquired* connectors below.
    const browserConnector = await resolveGrantedBrowserConnector({
      database,
      manifests,
      roleId: request.task.roleId,
    });
    // Resolved once, here, and reused for both dispatch and the system
    // prompt below — avoids a second getRole round-trip and, more
    // importantly, is what actually makes a role's provider choice
    // (TASK-213) reach production execution at all (TASK-220): nothing
    // previously consulted it, so a role's `provider` column had zero
    // effect on which lane a chat run actually took.
    const role = await getRole(options, request.task.roleId);
    if (role === null) throw new Error(`Cannot run chat task: role ${request.task.roleId} not found.`);
    const runtime = resolveRoleRuntime(role);
    let run;
    if (request.resume === undefined) {
      // A NEW run adopts the role's CURRENT resolved provider.
      run = await startTaskRun(options, { taskId: request.task.taskId, provider: runtime.provider, tenantId: request.task.tenantId });
      runId = run.runId;
    } else {
      runId = request.resume.runId;
      if (request.resume.sessionRef === undefined) {
        // Queue admission created this run already. It has no provider
        // session yet, so execute this persisted run rather than creating a
        // second one or manufacturing a resume token.
        const existing = await getRun(options, runId);
        if (existing === null) throw new Error(`Cannot execute unknown chat run ${runId}.`);
        run = existing;
      } else {
        if (request.resume.sessionRef.trim().length === 0) throw new Error(`Cannot resume chat run ${runId}: persisted session_ref is empty.`);
        run = await resumeInterruptedRun(options, runId);
        if (run.sessionRef === null) throw new Error(`Cannot resume chat run ${runId}: persisted session_ref is missing.`);
      }
    }
    // A RESUMED run stays on the provider it actually started on
    // (`run.provider`, persisted at creation) rather than re-resolving from
    // the role's CURRENT setting — a role's provider can change between
    // turns, and a mid-conversation switch would silently hand a resumed
    // Claude session to Gemini (or vice versa), which has no session to
    // resume there at all.
    effectiveProvider = request.resume === undefined ? runtime.provider : run.provider;
    // Fail closed on an unrecognized provider (Fable review R3):
    // `resolveRoleRuntime` returns whatever string a role/env var holds, no
    // validation — a typo, an unimplemented provider name, or a misconfigured
    // `OIK_DEFAULT_ROLE_PROVIDER` would otherwise fall through to the `else`
    // branch below and silently run the Claude lane while `run.provider` and
    // every audit trail said something else. That split-brain is worse than
    // a loud failure: an operator reading spend/audit records would believe
    // a run used a provider it never touched.
    if (effectiveProvider !== "claude" && effectiveProvider !== GEMINI_PROVIDER_ID) {
      throw new Error(`Unrecognized provider "${effectiveProvider}" for role ${request.task.roleId}: no execution lane exists for it.`);
    }
    const workspaceConnector = await resolveGrantedWorkspaceConnector({
      database, roleId: request.task.roleId, tenantId: request.task.tenantId,
      connectionString: options.connectionString, runId: run.runId, threadId: request.threadId,
    });
    const projectConnector = await resolveGrantedProjectConnector({
      database, roleId: request.task.roleId, tenantId: request.task.tenantId,
      connectionString: options.connectionString, runId: run.runId,
    });
    const connector = combineConnectorContexts(
      acquiredGmailConnector?.connector, workspaceConnector, projectConnector, acquiredCalendarConnector?.connector, acquiredDriveConnector?.connector, browserConnector,
    );
    const mountedToolNames = ["Bash", "Read", ...(connector?.allowedTools ?? [])];
    const policy = new PolicyRegistry({ mountedToolNames, policies: mountedToolNames.map((toolName) => ({ toolName })), manifestToolNames: [...registry.enabledToolNames] });
    const execution = resolveChatRunExecution(options);
    const projectId = await projectAttributionForChatRun(options, request);
    const budget = createChatRunBudget(options, request, run.runId, execution, projectId);
    noteFailureUnrecordedSpend = async () => {
      if (!geminiSpendRecorded && !budget.reported()) {
        await noteUnrecordedSpend(options, request, run.runId, execution);
      }
      if (reservationAdmitted) await releaseRunReservation(options, run.runId);
    };
    // Fail closed before any Claude tokens are spent: a ceiling already at
    // capacity must deny the turn, not allow one more unmetered query.
    await assertChatBudgetAllows(budget.check);
    await assertRunReservationAllows(options, { tenantId: request.task.tenantId, runId: run.runId, roleId: request.task.roleId, projectId, reserveUsd: chatTurnReservationUsd(effectiveProvider) });
    reservationAdmitted = true;
    void recordTimingSafe(runId, "setup", performance.now() - phaseStart);
    const modelStart = performance.now();
    let result;
    let botText: string | undefined;
    // Gemini records its own spend directly inside executeGeminiChatRun
    // (provider-specific: TASK-215's gate, TASK-210's `gemini` vocabulary),
    // never through `budget.tap`, so the generic `budget.reported()` check
    // below would misread a real (if zero) Gemini spend record as
    // unrecorded. Tracked separately rather than forcing Gemini through the
    // Claude-shaped tap.
    try {
      // TASK-224 — a user's `/skill-name` token (inserted verbatim by the
      // mobile composer's skill picker, apps/mobile/lib/screens/chat_screen.dart)
      // previously did nothing: buildRoleSystemPrompt alone never expanded
      // it, so the token sat as inert plain text in the prompt. Both the
      // Claude and Gemini lanes read this ONE systemPrompt value below, so
      // wiring it here reaches both without touching either lane
      // separately.
      // TASK-306 — profile-tier memory (user + this role's agent scope +
      // the project scope ONLY when the role is on that project's roster).
      // One read feeds the ONE systemPrompt both lanes consume.
      const memoryProjectId = await rosterProjectIdFor(options, projectId, request.task.roleId);
      const memoryFacts = await readProfileTier(options, {
        tenantId: request.task.tenantId,
        roleId: request.task.roleId,
        ...(memoryProjectId === null ? {} : { projectId: memoryProjectId }),
      });
      const systemPrompt = await assembleSystemPrompt({
        memoryFacts,
        role,
        fallbackRoleId: request.task.roleId,
        message: request.task.goal,
        resolveEnabledSkill: createSkillResolver(options, request.task.roleId),
      });
      if (effectiveProvider === GEMINI_PROVIDER_ID) {
        const geminiModel = runtime.model?.trim() || DEFAULT_GEMINI_MODEL;
        const geminiResult = await executeGeminiChatRun(options, database, manifests, request, run, systemPrompt, registry, policy, browserConnector, workspaceConnector, projectConnector, geminiModel, projectId);
        botText = geminiResult.text;
        geminiSpendRecorded = true;
      } else if (!shouldUseSandbox(options)) {
        // An injected query function is an established test-only SDK seam. Keep
        // it local so all existing TASK-116/153/154 tests remain meaningful;
        // real production runs (no queryFn) default to the sandbox.
        const workspace = await createChatRunWorkspace(run.runId);
        try {
          // ALS binds the tap/check for composeHarness inside executeTaskRun
          // (that file is outside this task's territory and cannot grow a
          // budgetTap option). composeHarness reads the store at composition
          // time and wraps the final harness.query + L1 PreToolUse gate.
          result = await runWithChatBudget(budget, () => executeTaskRun({
            prompt: request.task.goal,
            run: { runId: run.runId, roleId: request.task.roleId, tenantId: request.task.tenantId, agentRef: { provider: "claude", sessionRef: run.sessionRef ?? run.runId, isSubagent: false } },
            // L2 requires the scoped form; PolicyRegistry receives its bare name.
            allowedTools: ["Bash(*)", "Read(*)"],
            // Never inherit the worker process cwd or environment into a bot.
            // The Agent SDK forwards these values to its Bash/Read tool process.
            agentSdkOptions: {
              cwd: workspace,
              env: {},
              systemPrompt,
              ...(request.resume === undefined ? {} : { resume: run.sessionRef }),
            },
            ...(options.queryFn === undefined ? {} : { queryFn: options.queryFn }),
            ...(connector === undefined ? {} : { connector }),
            brokerDependencies: createBrokerDependencies(options, database, registry, policy),
            auditSink: completionAuditSink(options, run),
            park: createRunParkPort(options, run.runId),
          }));
        } finally {
          await removeChatRunWorkspace(workspace);
        }
      } else {
        result = await executeSandboxChatRun(options, database, manifests, request, run, systemPrompt, budget.tap, connector);
      }
    } finally {
      for (const acquiredConnector of [acquiredGmailConnector, acquiredCalendarConnector, acquiredDriveConnector]) {
        if (acquiredConnector !== undefined) acquiredConnector.pool.release(acquiredConnector.handle);
      }
    }
    void recordTimingSafe(runId, "model_execution", performance.now() - modelStart);
    const finalizeStart = performance.now();
    await insertMessage(options, { threadId: request.threadId, role: "bot", body: botText ?? finalText(result?.events ?? []), runId: run.runId });
    // A run that reached here having accounted for nothing is unrecorded, not
    // free. Say so explicitly rather than leaving an absence to be misread.
    if (!geminiSpendRecorded && !budget.reported()) {
      await noteUnrecordedSpend(options, request, run.runId, execution);
      // A completed Claude turn can legitimately have no SDK spend report
      // (for example a test seam or an interrupted CLI stream). It has not
      // recorded spend, so it must settle its admission exactly as the
      // pre-spend failure path does; otherwise the open reservation would
      // permanently consume the project/role ceiling.
      if (reservationAdmitted) {
        await releaseRunReservation(options, run.runId);
        reservationAdmitted = false;
      }
    }
    // TASK-269: persist the REAL session id the Claude CLI/Agent SDK itself
    // reports for this turn, so the THREAD's next turn (ports.ts's
    // `submitTaskExecution` continuity seeding, or a killed-worker's
    // `resumeInterruptedRun`) has a genuine session to `--resume` rather
    // than the `run.sessionRef ?? run.runId` fallback used elsewhere in
    // this file for broker/audit bookkeeping only -- the Claude CLI never
    // recognizes our own run UUID as a session id it can resume. Without
    // this write, the continuity fix is inert: `--resume <our-own-uuid>`
    // would find no matching CLI session and silently start fresh,
    // reproducing the exact bug this task exists to fix. Gemini keeps its
    // own separate, already-correct history mechanism (`buildGeminiTurnPrompt`)
    // and never reaches this branch. `resumeRun` overwrites unconditionally
    // (its COALESCE always prefers the new value when one is supplied) and
    // is legal here because the run is still in an open status -- this MUST
    // run before `completeTaskRun` below moves it to a terminal one.
    if (effectiveProvider === "claude") {
      const capturedSessionRef = extractClaudeSessionId(result?.events ?? []);
      if (capturedSessionRef !== undefined && capturedSessionRef !== run.sessionRef) {
        await dbResumeRun(options, run.runId, capturedSessionRef);
      }
    }
    await compactCompletedChatRun(options, request, run.runId);
    await completeTaskRun(options, run.runId);
    // This is the run's final write. Unlike earlier, observational phase
    // records, it must settle before run() resolves so readers never race it.
    await recordTimingSafe(runId, "finalize", performance.now() - finalizeStart);
  } catch (error) {
    if (runId !== undefined) {
      // §7.4: a failed run with no spend tap report is unrecorded, not free.
      await noteFailureUnrecordedSpend?.();
      // `request_secret` (Gemini lane, TASK-214 parity): the tool already
      // inserted its own `secret.requested` audit row inline (matching
      // workspaceMcpServer.ts's Claude behavior), so this branch only needs
      // to park — recording a second event here would double it.
      if (error instanceof GeminiSecretRequestedSignal) {
        await parkTaskRun(options, runId);
        return;
      }
      if (isHumanTakeoverSignal(error)) {
        // G-07's own event/park contract (this task's scope, not G-06a's):
        // a CAPTCHA/2FA/login-wall/payment signal from steelSession.ts is not
        // an ordinary run failure. Record the real, persisted event the
        // mobile client (TASK-188) can act on, then park via the same
        // `waiting_approval` machinery TASK-136/155 already established —
        // deliberately NOT `completeTaskRun`/`failTaskRun`, so the run stays
        // parked (zero further browser actions) rather than being reported
        // complete or failed.
        //
        // TASK-225: this catch is now reachable from BOTH lanes — a real
        // `HumanTakeoverRequiredError` from the Claude/MCP path, or a
        // `GeminiHumanTakeoverSignal` this driver throws itself once a Steel
        // Gemini tool's `onHumanTakeover` has fired. `actor` is therefore the
        // ACTUAL effective provider, not a Claude-only literal — mislabelling
        // a Gemini-triggered takeover as `agent:claude` would misattribute a
        // real audit record precisely where TASK-188's mobile client and any
        // future review of this event would trust it least.
        // Gemini persists the event in its detecting executor callback;
        // Claude reaches this catch directly and is recorded here.
        if (!(error instanceof GeminiHumanTakeoverSignal)) {
          await recordAuditEvent(options, {
            tenantId: request.task.tenantId,
            runId,
            actor: `agent:${effectiveProvider}`,
            eventType: HUMAN_TAKEOVER_REQUIRED_EVENT_TYPE,
            payload: { kind: error.kind, detail: error.detail },
          });
        }
        await parkTaskRun(options, runId);
        return;
      }
      const failureNote = sanitizeFailureReason(error instanceof Error ? error.message : "chat run failed") || "chat run failed";
      if (error instanceof SandboxSilenceError) {
        await recordAuditEvent(options, {
          tenantId: request.task.tenantId,
          runId,
          actor: `agent:${effectiveProvider}`,
          eventType: SANDBOX_SILENCE_EVENT_TYPE,
          payload: { category: "silence_timeout", silenceMs: error.silenceMs },
        }).catch((auditError: unknown) => {
          console.error("failed to record sandbox silence audit event:", auditError);
        });
      }
      await failTaskRun(options, runId, failureNote);
      // TASK-316: a terminal failure must not leave the user in silence.
      // Best-effort: a write failure here must not mask the original error.
      await insertMessage(options, {
        threadId: request.threadId,
        role: "system",
        body: error instanceof SandboxSilenceError ? silenceThreadMessage(error.silenceMs) : failureThreadMessage(failureNote),
      }).catch((insertError: unknown) => {
        console.error("failed to post chat run failure message:", insertError);
      });
    }
    throw error;
  } finally { await database.close(); }
}

async function describeHttpFailure(response: Response): Promise<string> {
  let detail = "";
  try {
    const body = JSON.parse(await response.clone().text()) as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") detail = body.error.message;
  } catch {
    // Non-JSON body: the status alone is still the useful part.
  }
  return `Gemini API HTTP ${response.status}${detail === "" ? "" : `: ${detail}`}`;
}

const FAILURE_REASON_MAX = 240;

/** Bounded, single-line, credential- and id-free rendering of a failure reason. */
export function sanitizeFailureReason(raw: string | undefined): string {
  if (raw === undefined) return "";
  const cleaned = raw
    .split(/\r?\n\s*at\s/)[0]!
    .replace(/\s+/g, " ")
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[redacted]")
    .replace(/\b(?:sk|pk|AIza|ghp|gho|xox[a-z])[-_A-Za-z0-9]{8,}/g, "[redacted]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "[redacted]")
    .trim();
  return cleaned.length > FAILURE_REASON_MAX ? `${cleaned.slice(0, FAILURE_REASON_MAX)}…` : cleaned;
}

function silenceThreadMessage(silenceMs: number): string {
  return `I couldn't finish that message: the bot stopped responding (no output for ${Math.round(silenceMs / 1000)} seconds), so I ended the run. You can retry.`;
}

function failureThreadMessage(reason: string): string {
  return `I couldn't answer that message: the model provider rejected or could not complete the turn. Reason: ${reason}. The owner can check the provider account, and you can retry once it is resolved.`;
}

export const HUMAN_TAKEOVER_REQUIRED_EVENT_TYPE = "run.human_takeover_required";
const HUMAN_TAKEOVER_ERROR_CODE = "HUMAN_TAKEOVER_REQUIRED";

interface HumanTakeoverSignal {
  readonly code: typeof HUMAN_TAKEOVER_ERROR_CODE;
  readonly kind: string;
  readonly detail: string;
}

/**
 * Duck-typed, not `instanceof`: `HumanTakeoverRequiredError`
 * (packages/connectors/src/steelSession.ts) is not re-exported from
 * @oikonomos/connectors's public surface (only "." is exported, and
 * steelSession.ts is not re-exported from its index.ts) — widening that
 * export map is outside this task's Owned_Paths. The `.code` field is the
 * stable wire contract TASK-186's own class already commits to (`readonly
 * code = "HUMAN_TAKEOVER_REQUIRED"`).
 */
function isHumanTakeoverSignal(error: unknown): error is HumanTakeoverSignal {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as Partial<HumanTakeoverSignal>;
  return candidate.code === HUMAN_TAKEOVER_ERROR_CODE
    && typeof candidate.kind === "string" && candidate.kind.length > 0
    && typeof candidate.detail === "string";
}

/**
 * TASK-225's own equivalent of `HumanTakeoverRequiredError` — duck-typed to
 * `HumanTakeoverSignal` for the exact same reason `isHumanTakeoverSignal`'s
 * own comment gives (the real class isn't re-exported from
 * `@oikonomos/connectors`'s public surface): thrown from
 * `executeGeminiChatRun` once `createSteelGeminiTools`'s `onHumanTakeover`
 * has fired, so it reaches this SAME outer catch and gets the identical
 * park/audit-event treatment the Claude lane already has.
 */
class GeminiHumanTakeoverSignal extends Error implements HumanTakeoverSignal {
  readonly code = HUMAN_TAKEOVER_ERROR_CODE;
  constructor(
    readonly kind: string,
    readonly detail: string,
  ) {
    super(`human takeover required: ${kind}`);
    this.name = "GeminiHumanTakeoverSignal";
  }
}

/**
 * Thrown once `request_secret`'s executor has called `onSecretRequested`
 * (TASK-214 Gemini parity). Deliberately its own class rather than reusing
 * `GeminiHumanTakeoverSignal`: a secret request is not a takeover, needs no
 * `run.human_takeover_required` event, and must not be duck-typed into
 * `isHumanTakeoverSignal`'s Claude-path branch.
 */
class GeminiSecretRequestedSignal extends Error {
  constructor() {
    super("secret requested — run parked pending human input");
    this.name = "GeminiSecretRequestedSignal";
  }
}

function shouldUseSandbox(options: CreateChatRunDriverOptions): boolean {
  if (options.sandboxClient !== undefined) return true;
  if (options.queryFn !== undefined || chatExecutionMode() === "local") return false;
  // The real database integration suite predates sandbox provisioning and
  // proves TASK-116/153/154 unchanged. A caller that wants a fake sandbox in
  // tests supplies sandboxClient explicitly; production is never NODE_ENV=test.
  return process.env.NODE_ENV !== "test";
}

/**
 * Threads a Gemini turn's prior conversation into its prompt (TASK-220 AC,
 * Fable review R5).
 *
 * Gemini has no resumable-session equivalent to the Claude Agent SDK's
 * `--resume`, so context has to be reconstructed from the persisted
 * transcript on every turn. Deliberately reuses TASK-193's own compaction
 * state (`thread_context`'s `epoch`/`compactedThroughMessageId`,
 * `thread_summaries`) rather than inventing a second history mechanism —
 * a Gemini turn respects the same "start fresh" epoch boundary and the same
 * summary-then-verbatim-tail shape `promptAssembly.ts`'s `assembleChatPrompt`
 * already formats for the (currently unwired) skills path, using the same
 * `[role] body` / `## Earlier in this conversation` conventions for
 * consistency rather than reusing that function directly — pulling it in
 * would also pull in its `resolveEnabledSkill` dependency, which has no
 * real implementation wired anywhere yet (a separate, pre-existing gap,
 * filed as TASK-224, not fixed here).
 *
 * `goal` is excluded from `history` when it already appears as history's
 * own last message: the chat route inserts the user's message into
 * `messages` BEFORE calling `runChatTask`, so by the time this runs, the
 * current turn is already persisted and would otherwise be duplicated.
 * A routine-triggered run has no such message, so nothing is excluded
 * there and `goal` is simply appended as the newest turn.
 */
async function buildGeminiTurnPrompt(
  options: CreateChatRunDriverOptions,
  threadId: string,
  systemPrompt: string,
  goal: string,
): Promise<string> {
  const context = await getOrInitThreadContext(options, threadId);
  const summary = await getLatestThreadSummary(options, threadId, context.epoch);
  const allHistory = await listMessages(
    options,
    threadId,
    context.compactedThroughMessageId === null ? {} : { after: context.compactedThroughMessageId },
  );
  const last = allHistory.at(-1);
  const history = last !== undefined && last.role === "user" && last.body === goal
    ? allHistory.slice(0, -1)
    : allHistory;

  const sections = [systemPrompt];
  if (summary !== null && summary.body.trim().length > 0) {
    sections.push(`## Earlier in this conversation\n\n${summary.body.trim()}`);
  }
  for (const message of history) sections.push(`[${message.role}] ${message.body}`);
  sections.push(goal);
  return sections.join("\n\n");
}

/** Execute a governed CLI turn in the persistent per-role OpenSandbox office. */
/**
 * Run one chat turn on Gemini (TASK-220).
 *
 * The caller that makes five separately-merged, individually-inert pieces
 * into a lane: the adapter, TASK-211's sandbox executors, TASK-212's tool
 * ceiling, TASK-215's budget gate and TASK-210's spend attribution. Every one
 * of those was green in isolation while no bot could run on Gemini at all.
 *
 * Deliberately mirrors `executeSandboxChatRun`'s shape: same sandbox, same
 * workspace, same egress-controlled container. The provider changes; the
 * isolation does not.
 */
export async function executeGeminiChatRun(
  options: CreateChatRunDriverOptions,
  database: Database,
  manifests: readonly ConnectorManifest[],
  request: ChatRunRequest,
  run: { readonly runId: string; readonly sessionRef: string | null },
  systemPrompt: string,
  registry: CapabilityRegistry,
  policy: PolicyRegistry,
  browserConnector?: ConnectorContext,
  workspaceConnector?: ConnectorContext,
  projectConnector?: ConnectorContext,
  model: string = DEFAULT_GEMINI_MODEL,
  projectId: string | null = null,
): Promise<{ readonly text: string; readonly costUsd: number }> {
  // Gate BEFORE composing anything: ADR-011 §7 forbids an uncapped
  // tool-executing Gemini run, and a denial must cost no tokens.
  const budget = await resolveGeminiBudget({
    db: options,
    routineId: request.task.routineId,
    routineBudgetUsd: null,
    platformCeilingUsd: (options.platformCeilingZar ?? DEFAULT_PLATFORM_CEILING_ZAR) / resolveUsdToZarRate(options),
  });
  if (budget.decision === "deny") throw new Error(budget.reason);

  const client = options.sandboxClient ?? productionSandboxClient();
  const resolvedSandbox = await resolveRoleSandbox(options, database, client, request.task.roleId, manifests);
  await assertManagedSettingsIntegrity(client, resolvedSandbox.endpoint);
  await assertEgressPolicyApplied(client, resolvedSandbox.endpoint, egressMarkerWaitMsFor(resolvedSandbox.image));
  const workspace = `/workspace/${safePathSegment(request.task.roleId)}`;
  await ensureSandboxWorkspace(client, resolvedSandbox.endpoint, workspace);

  // Persisted by the detecting Steel executor before it returns. Its terminal
  // result stops the Gemini loop before another batch member or retry.
  let takeoverSignal: { readonly kind: string; readonly detail: string } | undefined;
  // Set by `request_secret` (TASK-214 Gemini parity). No audit event needed
  // here — the tool inserts its own `secret.requested` row inline, exactly
  // as `workspaceMcpServer.ts` does for the Claude lane.
  let secretRequested = false;
  const steelTools = browserConnector === undefined
    ? []
    : createSteelGeminiTools(
        {
          client,
          endpoint: resolvedSandbox.endpoint,
          workspace,
          onHumanTakeover: async (kind, detail) => {
            takeoverSignal = { kind, detail };
            await recordAuditEvent(options, {
              tenantId: request.task.tenantId,
              runId: run.runId,
              actor: `agent:${GEMINI_PROVIDER_ID}`,
              eventType: HUMAN_TAKEOVER_REQUIRED_EVENT_TYPE,
              payload: { kind, detail },
            });
          },
          onNavigationDenied: async (category) => {
            await recordAuditEvent(options, {
              tenantId: request.task.tenantId,
              runId: run.runId,
              actor: `agent:${GEMINI_PROVIDER_ID}`,
              eventType: "steel_navigation_denied",
              payload: { category },
            });
          },
        },
        browserConnector.allowedTools,
      );
  const workspaceTools = workspaceConnector === undefined
    ? []
    : createWorkspaceGeminiTools(
        {
          connectionString: options.connectionString,
          tenantId: request.task.tenantId,
          roleId: request.task.roleId,
          threadId: request.threadId,
          runId: run.runId,
          onSecretRequested: () => { secretRequested = true; },
        },
      workspaceConnector.allowedTools,
    );
  const projectTools = projectConnector === undefined
    ? []
    : createProjectGeminiTools({
        connectionString: options.connectionString,
        tenantId: request.task.tenantId,
        roleId: request.task.roleId,
        runId: run.runId,
      }, projectConnector.allowedTools);

  let providerFailure: string | undefined;
  const composed = composeHarness<BrokerDependencies>({
    run: {
      runId: run.runId,
      roleId: request.task.roleId,
      tenantId: request.task.tenantId,
      agentRef: { provider: GEMINI_PROVIDER_ID, sessionRef: run.sessionRef ?? run.runId, isSubagent: false },
    },
    provider: "gemini",
    gemini: {
      // Tools execute inside the role's sandbox, never in this process.
      tools: [...createSandboxGeminiTools({ client, endpoint: resolvedSandbox.endpoint, workspace }), ...steelTools, ...workspaceTools, ...projectTools],
      maximumToolTier: STAGE_TWO_MAXIMUM_TOOL_TIER,
      // TASK-316: the harness-factory adapter reduces any non-2xx to a bare
      // `denied: true` with no reason, so observe failures at the fetch seam.
      fetch: async (...args: Parameters<typeof globalThis.fetch>) => {
        const response = await (options.geminiFetch ?? globalThis.fetch)(...args);
        if (!response.ok) providerFailure = await describeHttpFailure(response);
        return response;
      },
    },
    allowedTools: [],
    auditSink: completionAuditSink(options, { runId: run.runId, tenantId: request.task.tenantId }),
    pretooluse: {
      // No cast (Fable review R1): `as never` on the broker handler/deps
      // erased the compiler's check on exactly the enforcement wiring
      // non-negotiable #1 protects. executeRun.ts's own composeHarness call
      // passes the same two values uncast via the explicit `TDeps` generic;
      // this does the same.
      handlePreToolUse,
      dependencies: createBrokerDependencies(options, database, registry, policy),
    },
  });

  const adapter = composed.gemini;
  if (adapter === undefined) throw new Error("Gemini composition did not produce an adapter.");
  const prompt = await buildGeminiTurnPrompt(options, request.threadId, systemPrompt, request.task.goal);
  // TASK-296: the Gemini lane never paused the office before this — release
  // in a `finally` (wrapped by withSandboxRelease) so a thrown error from
  // adapter.run (broker denial, network failure, a tool crash) can't leave
  // the office Running/Resuming forever, mirroring the Claude lane's fix
  // below.
  // Explicit return-type annotation on the callback (rather than leaning on
  // inference from `adapter.run`'s own declared type) is deliberate: this
  // repo's `ComposedRuntime.gemini` field resolves structurally to `any` at
  // this call site (a pre-existing gap in `composeHarness`'s generics,
  // `packages/harness-factory` — out of this task's Owned_Paths and a
  // CLAUDE.md protected path besides, not touched here). Consuming `any`
  // directly is silently permissive either way, but TypeScript infers a
  // generic type PARAMETER from an `any`-typed source as `unknown` rather
  // than `any` (deliberate anti-contamination behaviour) — which
  // `withSandboxRelease<T>` would otherwise surface as `result: unknown`
  // below. Annotating the callback's own return type here sidesteps that by
  // giving the compiler a real shape to infer `T` from instead, matching
  // the fields this function already reads off `result` beneath it.
  const result = await withSandboxRelease(
    client,
    options,
    request.task.roleId,
    resolvedSandbox.sandboxId,
    (): Promise<{
      readonly text: string;
      readonly denied: boolean;
      readonly functionResponses?: readonly { readonly response?: unknown }[];
      readonly usage: {
        readonly promptTokenCount: number;
        readonly candidatesTokenCount: number;
        readonly thoughtsTokenCount: number;
        readonly totalTokenCount: number;
      };
    }> => adapter.run(prompt, model),
  );

  // Record spend BEFORE the denied check below (Fable review U1). A run
  // can make up to 11 real billed API calls and then exhaust the 12-turn
  // limit, hit a mid-loop deny, or get a safety-blocked 200 — every one of
  // those sets `denied: true` with real usage already spent. Throwing
  // before this point (the original order) meant that spend was recorded
  // nowhere: not here, and not via the success path's `noteUnrecordedSpend`
  // either, since that line is unreachable once an exception propagates
  // past the outer catch. `resolveGeminiBudget` computes the provider cap
  // from `spend_records`, so unrecorded spend from repeatedly-failing runs
  // could exceed `OIK_PROVIDER_CAP_USD_GEMINI` without bound — the adapter
  // fix made this spend visible; the driver was throwing it away.
  //
  // A successful run always records a row, even a genuinely zero-cost one
  // (matches the pre-existing invariant `geminiSpendRecorded` relies on to
  // suppress `spend.unrecorded`). A DENIED run records one only when real
  // tokens were actually billed (`totalTokenCount > 0`) — an immediate
  // structural denial (missing API key, empty prompt) truly cost nothing
  // and recording a noisy zero row for it would misrepresent the run as
  // having reached the API at all.
  const costUsd = geminiTurnCostUsd(model, result.usage);
  if (!result.denied || result.usage.totalTokenCount > 0) {
    await recordSpend(options, {
      runId: run.runId,
      tenantId: request.task.tenantId,
      routineId: request.task.routineId,
      provider: GEMINI_PROVIDER_ID,
      model,
      costUsd,
      tokens: result.usage.totalTokenCount,
      projectId,
    });
  }
  // TASK-225: checked AFTER spend is recorded above (same reasoning as the
  // denied-check below it replaces in priority — real tokens were spent
  // either way) but BEFORE returning success, so a takeover mid-run reaches
  // the outer catch's park/audit-event path rather than being reported as
  // an ordinary completed turn.
  if (takeoverSignal !== undefined) throw new GeminiHumanTakeoverSignal(takeoverSignal.kind, takeoverSignal.detail);
  if (secretRequested) throw new GeminiSecretRequestedSignal();
  if (result.denied) {
    const adapterError = (result.functionResponses?.[0]?.response as { error?: unknown } | undefined)?.error;
    const reason = sanitizeFailureReason(providerFailure ?? (typeof adapterError === "string" ? adapterError : undefined));
    throw new Error(reason === "" ? "Gemini run was denied before it could answer." : `Gemini run was denied before it could answer: ${reason}`);
  }
  return { text: result.text, costUsd };
}

async function executeSandboxChatRun(
  options: CreateChatRunDriverOptions,
  database: Database,
  manifests: readonly ConnectorManifest[],
  request: ChatRunRequest,
  run: { readonly runId: string; readonly sessionRef: string | null },
  systemPrompt: string,
  tap: BudgetTapSink,
  connector: { readonly allowedTools: readonly string[]; readonly mcpServers: McpServers } | undefined,
): Promise<{ readonly events: readonly unknown[] }> {
  const client = options.sandboxClient ?? productionSandboxClient();
  const resolvedSandbox = await resolveRoleSandbox(options, database, client, request.task.roleId, manifests);
  const agentRef = { provider: "claude", sessionRef: run.sessionRef ?? run.runId, isSubagent: false };
  const token = mintBrokerToken({ runId: run.runId, roleId: request.task.roleId, tenantId: request.task.tenantId, agentRef }, SANDBOX_COMMAND_TIMEOUT_MS);
  // Stream JSON makes each assistant/tool event a stdout chunk, which is the
  // actual liveness signal for TASK-338. The terminal result line retains the
  // SDK envelope (`total_cost_usd` + `modelUsage`) used for budget accounting.
  const command = claudePrintCommand(request.task.goal, systemPrompt, request.resume?.sessionRef, "stream-json", connector);
  await assertManagedSettingsIntegrity(client, resolvedSandbox.endpoint);
  await assertEgressPolicyApplied(client, resolvedSandbox.endpoint, egressMarkerWaitMsFor(resolvedSandbox.image));
  const workspace = `/workspace/${safePathSegment(request.task.roleId)}`;
  await ensureSandboxWorkspace(client, resolvedSandbox.endpoint, workspace);
  // TASK-296: release-on-failure. Previously `pauseSandbox` sat AFTER both
  // this call and the exit-code check below, so a thrown `runCommand`
  // (network failure, execd timeout) skipped it entirely and left the
  // office Running until the reaper's idle sweep eventually caught it.
  // `withSandboxRelease` pauses in a `finally` regardless of how
  // `runCommand` settles; the exit-code check still runs afterward and can
  // still throw for a non-zero exit — that throw now happens AFTER release
  // rather than before it.
  // TASK-338: silence guard. Every stream event re-arms the timer; if it ever
  // fires the command is cancelled and the run fails with a distinct error.
  const silenceMs = claudeSilenceTimeoutMs();
  const silence = new AbortController();
  let silenceTimer: ReturnType<typeof setTimeout> | undefined;
  let silenced = false;
  const armSilence = (): void => {
    if (silenceTimer !== undefined) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => { silenced = true; silence.abort(); }, silenceMs);
  };
  armSilence();
  let response: Awaited<ReturnType<SandboxClient["runCommand"]>>;
  try {
    response = await withSandboxRelease(client, options, request.task.roleId, resolvedSandbox.sandboxId, () =>
    client.runCommand(resolvedSandbox.endpoint, {
      command,
      cwd: workspace,
      onActivity: armSilence,
      signal: silence.signal,
      // This is the whole child environment. Never spread process.env here:
      // only the per-turn broker identity and model credential cross the
      // worker/sandbox boundary — the image itself carries neither (TASK-154).
      // PATH is required too: execd spawns the child directly (no interactive
      // shell to supply a compiled-in default), so without it `claude` — an
      // `npm install --global` binary living in /usr/local/bin, outside the
      // POSIX execvp() fallback search path (/bin:/usr/bin) — resolves to
      // "command not found" (exit 127). Confirmed live 2026-09-07: a bare
      // `env -i` invocation lacking PATH reproduces exit 127 byte-for-byte
      // against the real office-browser image; adding PATH back fixes it.
      envs: {
        [sandboxHookEnvironment.brokerUrl]: requiredSandboxBrokerUrl(),
        [sandboxHookEnvironment.brokerToken]: token,
        [sandboxHookEnvironment.runId]: run.runId,
        [sandboxHookEnvironment.roleId]: request.task.roleId,
        [sandboxHookEnvironment.tenantId]: request.task.tenantId,
        [sandboxHookEnvironment.agentProvider]: agentRef.provider,
        [sandboxHookEnvironment.agentSessionRef]: agentRef.sessionRef,
        ANTHROPIC_API_KEY: requiredSandboxAnthropicApiKey(),
        PATH: SANDBOX_CHILD_PATH,
        // The steel-mcp stdio server (spawned as `claude`'s own child, so it
        // inherits this same env) defaults to Steel Cloud and throws without
        // an API key we don't provision. office-browser's own entrypoint runs
        // Steel local-only on 127.0.0.1:3000 (browser-entrypoint.sh) — telling
        // the MCP server that is what makes it actually reach the browser
        // instead of the bot silently reporting "browser tools unavailable"
        // (confirmed live 2026-09-07: this was the last gap after the
        // shellQuote/PATH fixes — the command ran clean but steel-mcp had
        // nothing to connect to). Harmless to set when no connector is mounted.
        STEEL_LOCAL: "true",
      },
      timeoutMs: SANDBOX_COMMAND_TIMEOUT_MS,
    }),
    );
  } catch (error) {
    if (silenced) throw new SandboxSilenceError(silenceMs);
    throw error;
  } finally {
    if (silenceTimer !== undefined) clearTimeout(silenceTimer);
  }
  if (response.exitCode !== 0) throw new Error(`Sandboxed Claude command failed with exit code ${response.exitCode}.`);

  const event = eventFromSandboxStdout(response.stdout);
  const events: unknown[] = [];
  const tapped = withBudgetTap(async function* () { yield event; }, tap);
  for await (const tappedEvent of tapped({ prompt: request.task.goal })) events.push(tappedEvent);
  return { events };
}

/** Managed settings are an immutable security boundary for a persistent office. */
async function assertManagedSettingsIntegrity(client: SandboxClient, endpoint: SandboxEndpoint): Promise<void> {
  const result = await client.runCommand(endpoint, {
    command: `/usr/bin/sha256sum ${SANDBOX_MANAGED_SETTINGS_PATH}`,
    // The verification command receives no worker environment either.
    envs: {},
    timeoutMs: 10_000,
  });
  const observed = result.stdout.trim().split(/\s+/, 1)[0];
  if (result.exitCode !== 0 || observed !== SANDBOX_MANAGED_SETTINGS_SHA256) {
    throw new Error("Sandbox managed Claude settings failed the required integrity check.");
  }
}

/**
 * A root-owned image entrypoint writes this only after its sidecar reports a
 * live policy.
 *
 * TASK-208: polled, not checked once. OpenSandbox reports `Running` as soon
 * as the CONTAINER is up, which on office-browser is well before its
 * entrypoint has finished starting Steel Browser and `exec`ed into the
 * egress entrypoint that writes this marker — a real race, hit live
 * 2026-09-07 (the marker appeared ~30s after the single check refused).
 * Still fail-closed: a marker that never appears refuses exactly as before,
 * just after a bounded wait instead of instantly.
 */
const EGRESS_MARKER_POLL_MS = 2_000;

/**
 * Only office-browser needs the wait: its entrypoint starts Steel Browser
 * (and a full Chromium) before `exec`ing the egress entrypoint that writes
 * the marker. office-base writes it within its own startup, so it keeps the
 * original single-check behavior — an absent marker there is a genuine
 * refusal, not a race, and must fail instantly rather than hang.
 */
export function egressMarkerWaitMsFor(image: string): number {
  return image === OFFICE_BROWSER_SANDBOX_IMAGE ? 120_000 : 0;
}

async function assertEgressPolicyApplied(
  client: SandboxClient,
  endpoint: SandboxEndpoint,
  maxWaitMs: number,
): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const result = await client.runCommand(endpoint, {
      command: "test -f /run/oikonomos/egress-policy-applied",
      envs: {},
      timeoutMs: 10_000,
    });
    if (result.exitCode === 0) return;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, EGRESS_MARKER_POLL_MS));
  }
  throw new Error("Sandbox egress policy marker is absent; refusing governed command.");
}

/** Create the role's durable in-sandbox workspace before execd validates cwd. */
async function ensureSandboxWorkspace(client: SandboxClient, endpoint: SandboxEndpoint, workspace: string): Promise<void> {
  const result = await client.runCommand(endpoint, {
    command: `mkdir -p -- ${shellQuote(workspace)}`,
    cwd: "/workspace",
    // Workspace setup intentionally receives no worker environment or secrets.
    envs: {},
    timeoutMs: 10_000,
  });
  if (result.exitCode !== 0) throw new Error("Sandbox role workspace could not be prepared.");
}

function productionSandboxClient(): SandboxClient {
  const baseUrl = process.env.SANDBOX_INTEGRATION_URL?.trim();
  if (baseUrl === undefined || baseUrl.length === 0) {
    throw new Error("SANDBOX_INTEGRATION_URL must be set for sandbox chat execution (set OIKONOMOS_CHAT_EXECUTION_MODE=local only for development).");
  }
  return createSandboxClient({ baseUrl });
}

/**
 * TASK-311: per-role, in-process serialisation of office resolution. Chat
 * runs are deduplicated by runId (workerJobQueue singletonKey), NOT by role,
 * so two turns for one role can resolve concurrently; without this both would
 * see the same 404 and each create an office, orphaning one. Queued callers
 * re-read the record after the first finishes and find the fresh office.
 * Scope: one worker process (the deployment runs a single worker).
 */
const roleSandboxResolutionTails = new Map<string, Promise<unknown>>();

export function resolveRoleSandbox(
  options: DatabaseOptions,
  database: Database,
  client: SandboxClient,
  roleId: string,
  manifests: readonly ConnectorManifest[],
): Promise<{ readonly sandboxId: string; readonly endpoint: SandboxEndpoint; readonly image: string }> {
  const previous = roleSandboxResolutionTails.get(roleId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => resolveRoleSandboxUnlocked(options, database, client, roleId, manifests));
  const tail = run.catch(() => undefined);
  roleSandboxResolutionTails.set(roleId, tail);
  void tail.then(() => { if (roleSandboxResolutionTails.get(roleId) === tail) roleSandboxResolutionTails.delete(roleId); });
  return run;
}

async function resolveRoleSandboxUnlocked(
  options: DatabaseOptions,
  database: Database,
  client: SandboxClient,
  roleId: string,
  manifests: readonly ConnectorManifest[],
): Promise<{ readonly sandboxId: string; readonly endpoint: SandboxEndpoint; readonly image: string }> {
  // The image this role's office runs, whether it was created just now or on
  // an earlier turn — the caller needs it to know how long a slow-starting
  // image may take to write its egress marker (TASK-208).
  const roleImage = process.env.OIKONOMOS_SANDBOX_IMAGE?.trim()
    || (isBrowserLaneGranted(manifests, new Set((await database.listRoleGrants(roleId)).map((grant) => grant.capabilityId)))
      ? OFFICE_BROWSER_SANDBOX_IMAGE
      : SANDBOX_IMAGE);
  const createOffice = async (): Promise<RoleSandbox> => {
    const grants = await database.listRoleGrants(roleId);
    const egressPolicy = resolveEgressPolicy({ roleId, grants }, manifests);
    const networkPolicy = toOpenSandboxNetworkPolicy(egressPolicy);
    // AC1: a role granted browser.* capabilities gets the office-browser
    // image, not office-base, at sandbox creation time. An explicit
    // OIKONOMOS_SANDBOX_IMAGE override still wins for either case, matching
    // the pre-existing single-image override behavior exactly. `roleImage`
    // above resolves exactly that, and is reused here so the created image
    // and the one reported back to the caller can never disagree.
    const image = roleImage;
    const created = await client.createSandbox({
      image: { uri: image },
      // TASK-185: OpenSandbox's own container entrypoint is ALWAYS its own
      // `/opt/opensandbox/bootstrap.sh`, injected regardless of what the
      // image itself declares as ENTRYPOINT (verified live against clawsrv,
      // 2026-09-06 — `docker inspect` on a real created sandbox showed
      // `Config.Entrypoint = ["/opt/opensandbox/bootstrap.sh"]`, never the
      // image's own `["node", "/opt/oikonomos/egress-entrypoint.mjs"]`).
      // `bootstrap.sh` then runs whatever this API's own `entrypoint` field
      // says as its CMD (`"$@" &`) — so the marker-writing wrapper MUST be
      // named here explicitly; the image's `ENTRYPOINT` directive is only
      // ever reached by a plain `docker run` outside OpenSandbox (kept for
      // that direct-invocation/sanity-check use, not dead weight, but never
      // exercised by the real deployment).
      entrypoint: sandboxEntrypointFor(image),
      resourceLimits: sandboxResourceLimitsFor(image),
      // TASK-296: a backstop TTL so OpenSandbox's own reaper eventually
      // reclaims this office even if our app-level sweep never runs again
      // (see SANDBOX_SERVER_SIDE_TTL_SECONDS's own comment for the number).
      timeout: SANDBOX_SERVER_SIDE_TTL_SECONDS,
      metadata: { roleId },
      ...(networkPolicy === undefined ? {} : { networkPolicy }),
    });
    return upsertRoleSandbox(options, { roleId, sandboxId: created.id, state: created.status.state, execdTokenRef: SANDBOX_EXECD_TOKEN_REF });
  };
  let record = await getRoleSandbox(options, roleId);
  if (record === null) record = await createOffice();
  // The sandbox's OWN reported state is authoritative, not the DB's cached
  // copy (TASK-222). `record.state` is written back after every successful
  // transition, so this drifts only when something outside that path moves
  // the real container — a crashed mid-transition run, two worker instances
  // racing, or manual operator intervention (confirmed live, repeatedly,
  // 2026-09-07: `docker exec`/`unpause` for debugging without a matching DB
  // update). Trusting the stale value in either direction throws: resuming
  // an already-Running sandbox gets `DOCKER::SANDBOX_NOT_PAUSED`; skipping
  // resume on an actually-Paused one spins `waitForSandboxRunning` until its
  // own timeout, since a paused container never becomes Running on its own.
  // A `getSandbox` failure here (unreachable/unknown sandbox) is NOT caught —
  // that is a genuinely dead sandbox and must still fail closed, not be
  // silently treated as drift.
  // TASK-311: ONLY a definitive "this office no longer exists" answer (a 404,
  // or a Terminated/Failed live state) recreates it. Any other failure
  // (network, 5xx, auth) still throws: creating an office because the server
  // was briefly unreachable would duplicate a perfectly good one.
  let liveState: SandboxState | undefined;
  try {
    liveState = (await client.getSandbox(record.sandboxId)).status.state;
  } catch (error) {
    if (!(error instanceof SandboxClientError && error.status === 404)) throw error;
  }
  if (liveState === undefined || liveState === "Terminated" || liveState === "Failed") {
    record = await createOffice(); // upsertRoleSandbox overwrites the role's row with the new id
    liveState = (await client.getSandbox(record.sandboxId)).status.state;
  }
  if (liveState !== record.state) {
    await updateRoleSandboxState(options, roleId, liveState);
  }
  if (liveState === "Paused") {
    await client.resumeSandbox(record.sandboxId);
    await updateRoleSandboxState(options, roleId, "Resuming");
  }
  const running = await waitForSandboxRunning(client, record.sandboxId);
  await updateRoleSandboxState(options, roleId, running.status.state);
  return { sandboxId: record.sandboxId, endpoint: await client.getEndpoint(record.sandboxId), image: roleImage };
}

async function waitForSandboxRunning(client: SandboxClient, sandboxId: string): Promise<Sandbox> {
  const deadline = Date.now() + SANDBOX_READY_TIMEOUT_MS;
  do {
    const sandbox = await client.getSandbox(sandboxId);
    if (sandbox.status.state === "Running") return sandbox;
    if (sandbox.status.state === "Failed" || sandbox.status.state === "Terminated") {
      throw new Error(`Sandbox ${sandboxId} entered ${sandbox.status.state} while preparing a chat turn.`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  throw new Error(`Sandbox ${sandboxId} did not reach Running before the readiness timeout.`);
}

function requiredSandboxBrokerUrl(): string {
  const value = process.env.OIK_SANDBOX_BROKER_URL?.trim();
  if (value === undefined || value.length === 0) throw new Error("OIK_SANDBOX_BROKER_URL must be set for sandbox chat execution.");
  return value;
}

/**
 * The sandboxed `claude -p` CLI has no credential of its own by design
 * (TASK-154) and, per its own `--help`, authenticates non-interactively
 * ONLY via `ANTHROPIC_API_KEY` (OAuth/keychain/subscription logins are never
 * read headlessly, and — per Anthropic's Consumer Terms §3 — a subscription
 * credential must never authenticate automated/non-human access in the
 * first place). Read from `OIK_SECRET_*` to match this codebase's secret
 * env-var convention; never spread `process.env` here.
 */
function requiredSandboxAnthropicApiKey(): string {
  const value = process.env.OIK_SECRET_ANTHROPIC_API_KEY?.trim();
  if (value === undefined || value.length === 0) throw new Error("OIK_SECRET_ANTHROPIC_API_KEY must be set for sandbox chat execution.");
  return value;
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-");
}

function shellQuote(value: string): string {
  // POSIX single-quote escaping: close the quote, emit a backslash-escaped
  // literal single quote, reopen the quote. The prior `'\"'\"'` sequence
  // (backslash-DOUBLE-quote) silently closed the outer quoting instead of
  // re-escaping it, leaving everything after the first apostrophe as
  // unquoted shell text — confirmed live 2026-09-07 against the real
  // sandboxed CLI: a system prompt containing "I've" broke the whole
  // command into stray `I: command not found` lines and an unterminated
  // quote. Never exercised until this session's first genuine end-to-end
  // browser-lane chat run (all prior tests used apostrophe-free fixtures).
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The `envs` passed to `client.runCommand` is the whole child environment
 * (see the call site above) — execd spawns the process directly rather than
 * through an interactive shell, so nothing supplies a default PATH search
 * unless one is listed explicitly here. Matches every office-* image's own
 * `RUN npm install --global @anthropic-ai/claude-code` layout, which puts
 * the binary in /usr/local/bin — outside the POSIX execvp() fallback path.
 */
const SANDBOX_CHILD_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * Cheapest available model by default — the R350/month platform ceiling
 * (DEFAULT_PLATFORM_CEILING_ZAR) leaves very little headroom for sandboxed
 * turns. Override via OIKONOMOS_SANDBOX_MODEL for a specific role/routine
 * that genuinely needs a stronger model; never assume Sonnet/Opus pricing
 * fits this budget by default.
 */
const DEFAULT_SANDBOX_MODEL = "claude-haiku-4-5-20251001";

/**
 * `connector` extends the sandboxed CLI's own governed surface (AC2: browser
 * granted role reaches the CLI's allowed-tools set, not only the local
 * (non-sandbox) `mountedToolNames`/`PolicyRegistry` path gmail/calendar/
 * drive already used). Omitting it (the default, and every pre-existing
 * caller/test) reproduces the prior `Bash Read`-only command byte-for-byte.
 */
export function claudePrintCommand(
  prompt: string,
  systemPrompt: string,
  resume?: string,
  outputFormat: "text" | "json" | "stream-json" = "text",
  connector?: { readonly allowedTools: readonly string[]; readonly mcpServers: McpServers },
): string {
  const model = process.env.OIKONOMOS_SANDBOX_MODEL?.trim() || DEFAULT_SANDBOX_MODEL;
  const format = outputFormat;
  const allowedTools = ["Bash", "Read", ...(connector?.allowedTools ?? [])].join(" ");
  const mcpConfigFlag = connector === undefined || Object.keys(connector.mcpServers).length === 0
    ? []
    : ["--mcp-config", shellQuote(JSON.stringify({ mcpServers: connector.mcpServers }))];
  const effectiveSystemPrompt = connector === undefined || connector.allowedTools.length === 0
    ? systemPrompt
    : `${systemPrompt}\n\n# Tools available to you right now\nYou have exactly these tools: ${allowedTools}. There is no separate "WebSearch" tool and none can be added — do not call ToolSearch or ask the operator to enable one. To browse, call the mcp__steel__ tools directly: steel_session_create first to open a session, then steel_navigate to load a URL, then steel_snapshot or steel_screenshot to read what's on the page, and steel_session_release when you are done.\n\nOnly your FINAL message is delivered to the person who asked — nothing you write between tool calls reaches them. Put your complete answer in that last message, even if it repeats what you already wrote while working.`;
  return [
    "claude", "-p", "--permission-mode", "dontAsk", "--output-format", format,
    ...(format === "stream-json" ? ["--verbose"] : []), "--model", shellQuote(model),
    "--allowedTools", shellQuote(allowedTools), ...mcpConfigFlag, "--system-prompt", shellQuote(effectiveSystemPrompt),
    ...(resume === undefined ? [] : ["--resume", shellQuote(resume)]), shellQuote(prompt),
  ].join(" ");
}

/**
 * Map sandbox CLI stdout onto the SDK result envelope `withBudgetTap` reads.
 * With `--output-format stream-json`, select the terminal `type: result`
 * line from the incremental assistant/tool stream. Plain text (test fakes,
 * `--output-format text`) is a cost-less result — the tap leaves the sink
 * uncalled, matching TASK-150's cost-less stream.
 */
export function eventFromSandboxStdout(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  // Claude stream-json writes one JSON object per line. Read from the end so
  // the terminal result envelope wins over earlier assistant/tool events.
  for (const line of trimmed.split(/\r?\n/).reverse()) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (record.type === "result") return { ...record, type: "result" };
      }
    } catch {
      // Try the historical single-envelope and plain-text paths below.
    }
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (record.type === "result" || typeof record.result === "string") {
        return { ...record, type: "result" };
      }
    }
  } catch {
    // Not JSON: the historical text CLI format, or a test fake's stdout.
  }
  return { type: "result", result: trimmed };
}

/**
 * What actually executed a run, for spend attribution (TASK-210).
 *
 * `provider` MUST be the vocabulary `spend_records.provider` is read back
 * with — TASK-209's per-provider cap compares against that exact string, so
 * a run attributed to a name the cap does not key on is invisible to it.
 */
export interface ChatRunExecution {
  readonly provider: string;
  readonly model: string;
}

/** The Agent SDK picks its own model; we pin none, so name that rather than lie. */
export const LOCAL_LANE_MODEL = "claude-agent-sdk-default";

/**
 * Resolves who will run this turn, BEFORE it runs, so the same values gate
 * the budget and label the spend.
 *
 * Previously both were literals: `provider: "claude"` always, and the
 * sandbox model string even on the local lane, which pins no model at all.
 * That was already wrong for local-lane runs and would have recorded a
 * Gemini run as Claude — attributing spend to a provider that never ran it.
 */
export function resolveChatRunExecution(
  options: CreateChatRunDriverOptions,
  // Explicit rather than read internally: `shouldUseSandbox` keys on
  // NODE_ENV, which is always "test" under vitest, so an internally-derived
  // lane would make the sandbox branch — the production one — unreachable
  // from any test. Passing it in keeps this a pure function of its inputs.
  useSandbox: boolean = shouldUseSandbox(options),
): ChatRunExecution {
  return useSandbox
    ? { provider: "claude", model: process.env.OIKONOMOS_SANDBOX_MODEL?.trim() || DEFAULT_SANDBOX_MODEL }
    : { provider: "claude", model: LOCAL_LANE_MODEL };
}

/** Emitted when a run finished having recorded no spend at all (TASK-210). */
export const SPEND_UNRECORDED_EVENT_TYPE = "spend.unrecorded";

function createChatRunBudget(
  options: CreateChatRunDriverOptions,
  request: ChatRunRequest,
  runId: string,
  execution: ChatRunExecution,
  projectId: string | null,
): { tap: BudgetTapSink; check: BudgetGateCheck; reported: () => boolean } {
  const routineId = request.task.routineId;
  let reportCount = 0;
  return {
    tap: {
      async report(entry: { costUsd: number; tokens?: number }): Promise<void> {
        reportCount += 1;
        await recordSpend(options, {
          runId,
          tenantId: request.task.tenantId,
          routineId,
          provider: execution.provider,
          model: execution.model,
          costUsd: entry.costUsd,
          tokens: entry.tokens ?? null,
          projectId,
        });
      },
    },
    check: () => evaluateChatBudget(options, routineId),
    reported: () => reportCount > 0,
  };
}

const CHAT_TURN_RESERVATION_USD = { claude: 0.25, gemini: 0.10 } as const;

function chatTurnReservationUsd(provider: string, env: NodeJS.ProcessEnv = process.env): number {
  const defaultValue = provider === GEMINI_PROVIDER_ID ? CHAT_TURN_RESERVATION_USD.gemini : CHAT_TURN_RESERVATION_USD.claude;
  const key = provider === GEMINI_PROVIDER_ID ? "OIK_GEMINI_TURN_RESERVATION_USD" : "OIK_CLAUDE_TURN_RESERVATION_USD";
  const raw = env[key]?.trim();
  if (raw === undefined || raw.length === 0) return defaultValue;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${key} must be a finite number >= 0`);
  return value;
}

async function assertRunReservationAllows(options: DatabaseOptions, input: { tenantId: string; runId: string; roleId: string; projectId: string | null; reserveUsd: number }): Promise<void> {
  const result = await admitRunReservation(options, input);
  if (!result.admitted) {
    const reason: BudgetGateDenyReason = result.reason;
    throw new Error(reason);
  }
}

/** Project scope memory is member-only: a role off the roster gets no project facts. */
async function rosterProjectIdFor(options: DatabaseOptions, projectId: string | null, roleId: string): Promise<string | null> {
  if (projectId === null) return null;
  const members = await listProjectRoleMembers(options, projectId);
  return members.some((member) => member.roleId === roleId) ? projectId : null;
}

async function projectAttributionForChatRun(options: DatabaseOptions, request: ChatRunRequest): Promise<string | null> {
  const threadProject = await getProjectByThreadId(options, request.threadId);
  if (threadProject !== null) return threadProject.projectId;
  const execution = request.task.execution as (Record<string, unknown> | null | undefined);
  return typeof execution?.projectId === "string" && execution.projectId.length > 0 ? execution.projectId : null;
}

/**
 * A run that recorded no spend is not evidence of a free run — it is
 * evidence that nothing accounted for it. `withBudgetTap` only reports on a
 * terminal event carrying a numeric `total_cost_usd`, so a stream that ends
 * without one produces no `spend_records` row at all, and the run is
 * indistinguishable from one that genuinely cost nothing.
 *
 * That silence is what would let TASK-209's per-provider cap sit permanently
 * blind, so it is recorded as an audit event rather than inferred later from
 * an absence. Deliberately NOT a fabricated zero-cost spend row: inventing a
 * number is how an unaccounted run becomes a "free" one in a report.
 */
async function noteUnrecordedSpend(
  options: CreateChatRunDriverOptions,
  request: ChatRunRequest,
  runId: string,
  execution: ChatRunExecution,
): Promise<void> {
  try {
    await recordAuditEvent(options, {
      tenantId: request.task.tenantId,
      runId,
      actor: `agent:${execution.provider}`,
      eventType: SPEND_UNRECORDED_EVENT_TYPE,
      payload: { provider: execution.provider, model: execution.model },
    });
  } catch {
    // Never fail a completed run because its accounting footnote failed.
  }
}

async function assertChatBudgetAllows(check: BudgetGateCheck): Promise<void> {
  let decision;
  try {
    decision = await check();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`budget.check_failed: ${message}`);
  }
  if (decision.decision === "deny") throw new Error(decision.reason);
}

/**
 * Live, fail-closed budget decision reused from TASK-143's broker gate
 * (`resolveBudgetGate`) rather than a second decision function. Same
 * dangling-routine / timeout / malformed-config posture as
 * `wrapGateWithBudget`.
 */
async function evaluateChatBudget(
  options: CreateChatRunDriverOptions,
  routineId: string | null,
): Promise<{ readonly decision: "allow" } | { readonly decision: "deny"; readonly reason: string }> {
  const rate = resolveUsdToZarRate(options);
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    throw new Error("USD_TO_ZAR_RATE must be a finite number > 0");
  }
  const platformCeilingZar = options.platformCeilingZar ?? DEFAULT_PLATFORM_CEILING_ZAR;
  if (typeof platformCeilingZar !== "number" || !Number.isFinite(platformCeilingZar) || platformCeilingZar < 0) {
    throw new Error("platformCeilingZar must be a finite number >= 0");
  }
  const [routineSpendUsd, routineBudgetUsd, platformSpendUsd] = await withBudgetReadTimeout(
    Promise.all([
      routineId === null ? Promise.resolve(null) : getRoutineSpendUsd(options, routineId),
      routineId === null ? Promise.resolve(null) : getRoutineBudgetUsd(options, routineId),
      getPlatformSpendUsd(options),
    ]),
  );
  return resolveBudgetGate({
    routineSpendUsd,
    routineBudgetUsd,
    platformSpendUsd,
    platformCeilingUsd: platformCeilingZar / rate,
  });
}

async function getRoutineBudgetUsd(db: DatabaseOptions, routineId: string): Promise<number | null> {
  const routine = await getRoutine(db, routineId);
  if (routine === null) {
    throw new Error(`budget.dangling_routine: routine ${routineId} not found`);
  }
  const value = (routine.definition as Record<string, unknown> | null)?.budgetUsd;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function resolveUsdToZarRate(options: CreateChatRunDriverOptions): number {
  if (options.usdToZarRate !== undefined) return options.usdToZarRate;
  const raw = process.env.USD_TO_ZAR_RATE?.trim();
  if (raw !== undefined && raw.length > 0) return Number(raw);
  return DEFAULT_USD_TO_ZAR_RATE;
}

function withBudgetReadTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`budget.read_timeout: exceeded ${BUDGET_READ_TIMEOUT_MS}ms`));
    }, BUDGET_READ_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error as Error);
      },
    );
  });
}

/** Runs TASK-179's real Postgres compaction ports after every completed chat response. */
async function compactCompletedChatRun(
  options: CreateChatRunDriverOptions,
  request: ChatRunRequest,
  runId: string,
): Promise<void> {
  const role = await getRole(options, request.task.roleId);
  let tierZero: ReturnType<typeof createTierZeroProvider> | undefined;
  await maybeCompact({
    threadId: request.threadId,
    systemPrompt: buildRoleSystemPrompt(role, request.task.roleId),
    // Construct only when the measured meter actually crosses its threshold;
    // ordinary short chat turns must not require Tier-0 environment config.
    summarize: async (prompt) => {
      tierZero ??= createTierZeroProvider({ db: options, runId, ...resolveTierZeroProviderOptions(options) });
      return tierZero(prompt);
    },
    ports: {
      loadState: async (threadId) => getOrInitThreadContext(options, threadId),
      loadLatestSummary: async (threadId, epoch) => getLatestThreadSummary(options, threadId, epoch),
      loadMessagesSince: async (threadId, _epoch, afterMessageId) => {
        const messages = await listMessages(options, threadId, afterMessageId === null ? {} : { after: afterMessageId });
        return messages.map(({ id, role, body }) => ({ id, role, body }));
      },
      saveSummary: (input) => insertThreadSummary(options, input),
      updateState: async (threadId, patch) => { await updateThreadContext(options, threadId, patch); },
      insertSystemMessage: async (threadId, body) => { await insertMessage(options, { threadId, role: "system", body }); },
    },
  });
}

function resolveTierZeroProviderOptions(
  options: CreateChatRunDriverOptions,
): Omit<CreateTierZeroProviderOptions, "db" | "runId"> {
  if (options.tierZeroProviderOptions !== undefined) return options.tierZeroProviderOptions;
  const resolved = resolveTierZeroEnvConfig();
  if (resolved === undefined) {
    throw new Error("Set GEMINI_API_KEY (preferred) or FREE_LLM_API_ENDPOINT + FREE_LLM_API_MODEL for context compaction.");
  }
  return resolved;
}

/**
 * TASK-136 — the real `RunParkPort` `runChatTask` wires into `executeTaskRun`.
 * `withPark` in `packages/harness-factory` calls `park()` exactly once, only
 * when L1 denies a tool use for a reason in `PARK_REASONS` (`approval_pending`
 * plus the fail-closed broker-error reasons, CAN-04) — this transitions the
 * run's DB status to `waiting_approval` via the typed `parkTaskRun` accessor,
 * closing the gap TASK-135 documented (no chat run ever reached that status
 * in production before this). The Agent SDK query loop continues after a
 * denial (the tool call simply fails for that turn), so the run still runs
 * to completion/failure normally afterward; `completeRun`/`failRun` both
 * already accept `waiting_approval` as a legal source status, so no further
 * change is needed for the run to still terminate correctly. Deliberately
 * scoped to reaching-and-proving `waiting_approval` only, per this task's own
 * Description: the harder "resume the live session after a human grants the
 * approval" question is out of scope for this task (see dossier).
 */
function createRunParkPort(options: DatabaseOptions, runId: string): RunParkPort {
  return {
    park: async () => {
      await parkTaskRun(options, runId);
    },
  };
}

function createBrokerDependencies(options: DatabaseOptions, database: Database, registry: CapabilityRegistry, policy: PolicyRegistry): BrokerDependencies {
  return {
    isCapabilitiesEnabled: () => process.env.OIKONOMOS_CAPABILITIES_ENABLED === "true",
    ...registry.brokerPorts(database), destinationFor, issueApproval, verifyAndConsume,
    issueApprovalDependencies: { database: options }, consumeDependencies: { database: options }, manifestMap: policy.manifestMap,
    recordDecision: async (event) => ({ eventId: (await recordDecision(options, event)).eventId }),
  };
}

interface CompletionAuditSink {
  writeCompletionEvidence(evidence: { toolUseId: string; toolName: string; resultDigest: string; artifactUris: readonly string[] }): Promise<void>;
}
function completionAuditSink(options: DatabaseOptions, run: { runId: string; tenantId: string }): CompletionAuditSink {
  return { writeCompletionEvidence: async (evidence) => { await recordAuditEvent(options, { tenantId: run.tenantId, runId: run.runId, actor: "agent:claude", eventType: "tool.completed", payload: { ...evidence } }); } };
}

/**
 * Steel's two observational tools (steel_snapshot/steel_screenshot) act on
 * whatever page is already open rather than a caller-specified target — no
 * manifest input field names one. A fixed, non-secret literal still gives
 * the broker/audit trail a governed destination to key on; it deliberately
 * never carries real page/URL content (N4-adjacent: nothing browsed is ever
 * echoed here).
 */
const STEEL_CURRENT_PAGE_DESTINATION = "current_page";

/** ADR-013's v1 target extraction. Unknown shapes deliberately fail closed. */
/**
 * Sentinel for a tool whose target is the account's own implicit scope rather
 * than anything the call names — "the most recent files", not a file. Used
 * sparingly and only where no input field identifies a target, for the same
 * reason as {@link STEEL_CURRENT_PAGE_DESTINATION}: an approval render has to
 * say something true, and inventing a specific-looking target would be worse
 * than admitting the call names none.
 */
const ACCOUNT_SCOPE_DESTINATION = "account_scope";

/** Joins Gmail's array recipient fields; a single string still works. */
function recipients(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const addresses = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
    return addresses.length === 0 ? undefined : addresses.join(", ");
  }
  return undefined;
}

/**
 * ADR-013's v1 target extraction, one entry per governed tool.
 *
 * TASK-216: this was a nested ternary covering four of the nineteen tools the
 * connector manifests declare, so `create_draft`, `get_event` and nine live
 * Drive tools all threw "No governed destination" and were denied — failing
 * CLOSED, so not a security hole, but a draft-only Gmail bot genuinely could
 * not draft. Field names for Gmail and Drive are the real ones from those
 * MCP servers' own schemas, not inferred: note `create_draft`'s `to` is an
 * ARRAY while `send_message`'s is a string, which a copied branch would have
 * silently mishandled into an empty destination and another denial.
 */
const DESTINATION_EXTRACTORS: Readonly<Record<string, (input: Record<string, unknown>) => unknown>> = {
  Read: (input) => input.file_path,
  Edit: (input) => input.file_path,
  Write: (input) => input.file_path,
  Glob: (input) => input.path ?? input.pattern,
  Grep: (input) => input.path ?? input.pattern,
  Bash: (input) => input.command,

  mcp__gmail__list_messages: (input) => input.q,
  mcp__gmail__send_message: (input) => recipients(input.to),
  mcp__gmail__create_draft: (input) => recipients(input.to) ?? input.subject,

  "mcp__google-calendar__list_events": (input) => input.calendarId,
  // Google Calendar's API names this `eventId`; the project's own MCP server
  // has not been enumerated for this tool (docs/connectors/google-calendar.md
  // records tiers only), so `calendarId` is accepted as a fallback. If both
  // are absent this denies exactly as it does today — no behaviour is lost by
  // the uncertainty, only regained when the convention holds.
  "mcp__google-calendar__get_event": (input) => input.eventId ?? input.calendarId,

  "mcp__google-drive__search_files": (input) => input.query,
  "mcp__google-drive__list_recent_files": () => ACCOUNT_SCOPE_DESTINATION,
  "mcp__google-drive__get_file_metadata": (input) => input.fileId,
  "mcp__google-drive__read_file_content": (input) => input.fileId,
  "mcp__google-drive__download_file_content": (input) => input.fileId,
  "mcp__google-drive__create_file": (input) => input.title,
  "mcp__google-drive__update_file": (input) => input.fileId,
  "mcp__google-drive__copy_file": (input) => input.fileId,
  "mcp__google-drive__trash_file": (input) => input.fileId,
  "mcp__google-drive__share_file": (input) => input.fileId,
  "mcp__google-drive__get_file_permissions": (input) => input.fileId,

  [WORKSPACE_SEND_TO_ROLE_TOOL]: (input) => input.toRoleId,
  [WORKSPACE_RENAME_SELF_TOOL]: (input) => input.name,
  [WORKSPACE_REQUEST_SECRET_TOOL]: (input) => input.label,
  [WORKSPACE_CREATE_ROUTINE_TOOL]: (input) => input.name,
  // TASK-282's own tools never got entries here, so handlePreToolUse's
  // unconditional destinationFor() call (resolved before any tier check,
  // for every request) has been fail-closing every real create_bot call in
  // production since TASK-282 merged -- found while investigating TASK-285.
  mcp__workspace__create_bot: (input) => input.name,
  mcp__workspace__retire_bot: (input) => input.roleId,

  // Project MCP has no external destination, but each operation has a
  // concrete project/task/artifact target for the broker audit and any
  // future approval rendering.  Keep this closed table exhaustive: an
  // undeclared project verb still fails before it can reach the server.
  mcp__project__list_board: (input) => input.projectId,
  mcp__project__create_task: (input) => input.projectId,
  mcp__project__update_task: (input) => input.taskId,
  mcp__project__assign_task: (input) => input.taskId,
  mcp__project__register_artifact: (input) => input.ref,
  mcp__project__record_decision: (input) => input.projectId,

  mcp__steel__steel_navigate: (input) => {
    if (typeof input.url !== "string") return input.url;
    const navigation = guardNavigationTarget(input.url);
    if (navigation.decision === "deny") throw new BrokerFailure(`navigation.denied.${navigation.category}`);
    return navigation.url;
  },
  mcp__steel__steel_act: (input) => input.action,
  mcp__steel__steel_snapshot: () => STEEL_CURRENT_PAGE_DESTINATION,
  mcp__steel__steel_screenshot: () => STEEL_CURRENT_PAGE_DESTINATION,
  mcp__steel__steel_session_create: () => STEEL_CURRENT_PAGE_DESTINATION,
  mcp__steel__steel_session_release: () => STEEL_CURRENT_PAGE_DESTINATION,
};

export function destinationFor(request: PreToolUseRequest): string {
  // An unknown tool has no entry and therefore no destination: unchanged
  // fail-closed behaviour, which is the whole point of a closed table.
  const destination = DESTINATION_EXTRACTORS[request.toolName]?.(request.input);
  if (typeof destination !== "string" || destination.trim().length === 0) throw new Error(`No governed destination for tool '${request.toolName}'.`);
  return destination;
}

/**
 * TASK-269 — the real Claude CLI/Agent SDK session id for this turn, read
 * off whichever event actually carries it. The sandboxed CLI lane's single
 * synthesized event (`eventFromSandboxStdout`) spreads the CLI's own
 * `--output-format json` result envelope verbatim, and the real CLI's
 * `result` message includes a top-level `session_id` string; the local
 * (non-sandbox) Agent SDK lane streams the same field on its own result
 * event. Scans every event (not just the last) since either lane may also
 * emit earlier, non-result events with no such field. Returns `undefined`
 * on anything that isn't a genuine non-empty string -- a missing session id
 * must never be treated as "no continuity needed" silently; the caller
 * checks this return value explicitly rather than defaulting it.
 */
export function extractClaudeSessionId(events: readonly unknown[]): string | undefined {
  for (const event of events) {
    if (typeof event !== "object" || event === null) continue;
    const value = (event as { session_id?: unknown }).session_id;
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

export function finalText(events: readonly unknown[]): string {
  for (const event of [...events].reverse()) if (typeof event === "object" && event !== null && typeof (event as { result?: unknown }).result === "string") {
    const result = (event as { result: string }).result.trim(); if (result.length > 0) return result;
  }
  return "I completed the requested chat run.";
}

function assertRequest(request: ChatRunRequest): void {
  if (typeof request?.threadId !== "string" || request.threadId.trim().length === 0) throw new Error("chat run requires threadId.");
  if (typeof request?.task?.taskId !== "string" || request.task.taskId.trim().length === 0) throw new Error("chat run requires task.");
  if (request.resume !== undefined && (typeof request.resume.runId !== "string" || request.resume.runId.trim().length === 0 || (request.resume.sessionRef !== undefined && typeof request.resume.sessionRef !== "string"))) {
    throw new Error("chat run resume requires a runId and sessionRef.");
  }
}

if (import.meta.vitest) {
  const { afterAll, beforeAll, describe, expect, it } = import.meta.vitest;

  describe("chat run driver — TASK-163 budget helpers (no DB)", () => {
    it("keeps the 3-arg CLI helper on text output and emits verbose stream-json when asked", () => {
      expect(claudePrintCommand("hi", "sp")).toContain("--output-format text");
      expect(claudePrintCommand("hi", "sp", undefined, "json")).toContain("--output-format json");
      expect(claudePrintCommand("hi", "sp", undefined, "json")).not.toContain("--output-format text");
      expect(claudePrintCommand("hi", "sp", undefined, "stream-json")).toContain("--output-format stream-json --verbose");
    });

    it("maps a genuine SDK result envelope from sandbox JSON, and treats plain text as cost-less", () => {
      const json = eventFromSandboxStdout(JSON.stringify({
        type: "result",
        subtype: "success",
        result: "hello from json",
        total_cost_usd: 0.042,
        modelUsage: {
          "claude-haiku-4-5-20251001": {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        },
      }));
      expect(json).toMatchObject({ type: "result", result: "hello from json", total_cost_usd: 0.042 });
      expect(eventFromSandboxStdout("Sandbox turn complete")).toEqual({
        type: "result",
        result: "Sandbox turn complete",
      });
    });

    it("preserves the terminal result cost and usage from realistic Claude stream-json output (TASK-338)", () => {
      const result = {
        type: "result",
        subtype: "success",
        result: "tool-assisted answer",
        total_cost_usd: 0.042,
        modelUsage: { "claude-haiku": { inputTokens: 12, outputTokens: 34, cacheReadInputTokens: 5, cacheCreationInputTokens: 0 } },
      };
      const stream = [
        JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }),
        JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }),
        JSON.stringify(result),
      ].join("\n");
      expect(eventFromSandboxStdout(stream)).toEqual(result);
    });

    it("extractClaudeSessionId (TASK-269) finds a real CLI/SDK session_id anywhere in the event stream", () => {
      expect(extractClaudeSessionId([
        { type: "system", subtype: "init", session_id: "sess-abc-123" },
        { type: "result", subtype: "success", result: "hi" },
      ])).toBe("sess-abc-123");
      // The sandboxed CLI lane synthesizes exactly one event
      // (eventFromSandboxStdout), which spreads the CLI's own JSON result
      // envelope verbatim -- session_id lives directly on it.
      expect(extractClaudeSessionId([
        eventFromSandboxStdout(JSON.stringify({ type: "result", result: "hi", session_id: "sandbox-sess-1" })),
      ])).toBe("sandbox-sess-1");
    });

    it("extractClaudeSessionId returns undefined rather than a placeholder when no event carries a session id", () => {
      expect(extractClaudeSessionId([])).toBeUndefined();
      expect(extractClaudeSessionId([{ type: "result", result: "no session id here" }])).toBeUndefined();
      expect(extractClaudeSessionId([{ session_id: "" }, { session_id: 42 }, null, "not an object"])).toBeUndefined();
    });
  });

  const connectionString = process.env.DATABASE_URL;
  const integration = connectionString === undefined ? describe.skip : describe;

  integration("createChatRunDriver — Claude SDK spend + budget gate (TASK-163)", () => {
    const roleId = "task-163-chat-budget";
    const db: DatabaseOptions = { connectionString: connectionString! };
    let pool: { query: (sql: string, params?: unknown[]) => Promise<unknown>; end: () => Promise<void> };
    let routineId: string;
    let threadId: string;

    async function cleanup(): Promise<void> {
      await pool.query(`DELETE FROM spend_records WHERE run_id IN (SELECT run_id::text FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1))`, [roleId]);
      await pool.query(`DELETE FROM spend_records WHERE run_id LIKE 'task-163-%'`);
      await pool.query(`DELETE FROM audit_events WHERE run_id IN (SELECT run_id FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1))`, [roleId]);
      await pool.query(`DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE role_id = $1)`, [roleId]);
      await pool.query(`DELETE FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1)`, [roleId]);
      await pool.query(`DELETE FROM tasks WHERE role_id = $1`, [roleId]);
      await pool.query(`DELETE FROM thread_members WHERE role_id = $1`, [roleId]);
      await pool.query(`DELETE FROM threads WHERE role_id = $1`, [roleId]);
      await pool.query(`DELETE FROM role_sandboxes WHERE role_id = $1`, [roleId]);
      await pool.query(`DELETE FROM role_routines WHERE role_id = $1`, [roleId]);
      await pool.query(`DELETE FROM role_grants WHERE role_id = $1`, [roleId]);
      // TASK-224's own skill-wiring test: role_skills before roles (FK) AND
      // before skills (FK) — skills has no role_id of its own, scoped by
      // name instead.
      await pool.query(`DELETE FROM role_skills WHERE role_id = $1`, [roleId]);
      await pool.query(`DELETE FROM skills WHERE name LIKE 'task-224-%'`);
      await pool.query(`DELETE FROM roles WHERE role_id = $1`, [roleId]);
    }

    beforeAll(async () => {
      const pg = await import("pg");
      const { createRole, createRoutine, getOrCreateThreadForRole } = await import("@oikonomos/db");
      pool = new pg.Pool({ connectionString: connectionString! });
      await cleanup();
      await createRole(db, { roleId, name: roleId, title: "TASK-163 budget fixture" });
      const routine = await createRoutine(db, { roleId, name: "task-163-routine", definition: { budgetUsd: 5 } });
      routineId = routine.routineId;
      const thread = await getOrCreateThreadForRole(db, { roleId });
      threadId = thread.id;
    });

    afterAll(async () => {
      await cleanup();
      await pool.end();
    });

    it("records spend from a genuine-shaped SDK result on the local queryFn path", async () => {
      const { createTask, getRoutineSpendUsd } = await import("@oikonomos/db");
      const task = await createTask(db, {
        roleId,
        title: "TASK-163 sdk spend",
        goal: "Reply once.",
        requestedBy: "task-163-suite",
        routineId,
      });
      const queryFn: AgentSdkQueryFn = async function* () {
        yield {
          type: "result",
          subtype: "success",
          result: "sdk spend recorded",
          total_cost_usd: 0.25,
          modelUsage: {
            "claude-haiku-4-5-20251001": {
              inputTokens: 80,
              outputTokens: 20,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
          },
        };
      };
      await createChatRunDriver({
        ...db,
        queryFn,
        manifests: [],
        platformCeilingZar: 1_000_000,
      }).run({ task, threadId });
      expect(await getRoutineSpendUsd(db, routineId)).toBeCloseTo(0.25);
    });

    // TASK-230 — control-liveness assertion for the per-phase latency
    // instrumentation: proves real rows land in `run_phase_timings` for a
    // real run, not just that the recording code exists and compiles. If
    // this instrumentation ever goes inert (e.g. a future refactor drops
    // the `recordTimingSafe` calls), this test fails; a test asserting
    // only that `queryRunLatencyStats` returns the right *shape* would not
    // have caught that.
    it("records real per-phase timing rows for a completed run (control-liveness)", async () => {
      const { createTask, listRuns } = await import("@oikonomos/db");
      const task = await createTask(db, {
        roleId,
        title: "TASK-230 latency liveness",
        goal: "Reply once.",
        requestedBy: "task-230-suite",
        routineId,
      });
      const queryFn: AgentSdkQueryFn = async function* () {
        yield { type: "result", subtype: "success", result: "timed run" };
      };
      await createChatRunDriver({
        ...db,
        queryFn,
        manifests: [],
        platformCeilingZar: 1_000_000,
      }).run({ task, threadId });

      const { runs } = await listRuns(db, { taskId: task.taskId, limit: 1 });
      expect(runs).toHaveLength(1);
      const runId = runs[0]!.runId;

      const rows = await pool.query(
        `SELECT phase, duration_ms FROM run_phase_timings WHERE run_id = $1 ORDER BY phase`,
        [runId],
      ) as { rows: Array<{ phase: string; duration_ms: number }> };

      const phases = rows.rows.map((r) => r.phase).sort();
      expect(phases).toEqual(["finalize", "model_execution", "setup"]);
      for (const row of rows.rows) {
        expect(row.duration_ms).toBeGreaterThanOrEqual(0);
      }
    });

    // TASK-224 — control-liveness for skill-block wiring: a real
    // `/skill-name` token, exactly as the mobile composer's skill picker
    // inserts it (apps/mobile/lib/screens/chat_screen.dart:219,
    // `_composeController.text = '/${skill.name} '`), must produce a real
    // `## Skill: <name>` block inside the ACTUAL prompt the model receives
    // — captured from the real queryFn call, not inferred from
    // promptAssembly.ts's own already-passing unit tests, which prove
    // nothing about whether any execution lane actually calls it.
    it("expands a real /skill-name token into a skill block in the actual model prompt (control-liveness)", async () => {
      const { createTask, createSkill, setEnabledForRole } = await import("@oikonomos/db");
      const skill = await createSkill(db, {
        name: "task-224-standup",
        description: "Posts a daily standup summary.",
        whenToUse: "When asked for a status update.",
        body: "1. Summarize yesterday.\n2. List blockers.",
      });
      await setEnabledForRole(db, roleId, skill.skillId, true);

      const task = await createTask(db, {
        roleId,
        title: "TASK-224 skill wiring",
        goal: "/task-224-standup please",
        requestedBy: "task-224-suite",
        routineId,
      });
      let capturedSystemPrompt: unknown;
      const queryFn: AgentSdkQueryFn = async function* (input) {
        capturedSystemPrompt = (input.options as { systemPrompt?: unknown } | undefined)?.systemPrompt;
        yield { type: "result", subtype: "success", result: "standup posted" };
      };
      await createChatRunDriver({
        ...db,
        queryFn,
        manifests: [],
        platformCeilingZar: 1_000_000,
      }).run({ task, threadId });

      expect(typeof capturedSystemPrompt).toBe("string");
      const prompt = capturedSystemPrompt as string;
      expect(prompt).toContain("## Skill: task-224-standup");
      expect(prompt).toContain("When to use: When asked for a status update.");
      expect(prompt).toContain("List blockers.");
    });

    it("leaves a /name token referencing no enabled skill as a system-visible note, not silently dropped (control-liveness)", async () => {
      const { createTask } = await import("@oikonomos/db");
      const task = await createTask(db, {
        roleId,
        title: "TASK-224 unknown skill token",
        goal: "/does-not-exist please",
        requestedBy: "task-224-suite",
        routineId,
      });
      let capturedSystemPrompt: unknown;
      const queryFn: AgentSdkQueryFn = async function* (input) {
        capturedSystemPrompt = (input.options as { systemPrompt?: unknown } | undefined)?.systemPrompt;
        yield { type: "result", subtype: "success", result: "ok" };
      };
      await createChatRunDriver({
        ...db,
        queryFn,
        manifests: [],
        platformCeilingZar: 1_000_000,
      }).run({ task, threadId });

      const prompt = capturedSystemPrompt as string;
      expect(prompt).toContain("skill 'does-not-exist' is not enabled for this bot");
    });

    it("denies the turn when the platform ceiling is already at capacity (hard ceiling)", async () => {
      const { createTask, listRuns } = await import("@oikonomos/db");
      const task = await createTask(db, {
        roleId,
        title: "TASK-163 ceiling deny",
        goal: "Must not spend.",
        requestedBy: "task-163-suite",
      });
      let queried = false;
      const queryFn: AgentSdkQueryFn = async function* () {
        queried = true;
        yield { type: "result", result: "should not run" };
      };
      await expect(
        createChatRunDriver({
          ...db,
          queryFn,
          manifests: [],
          usdToZarRate: 1,
          platformCeilingZar: 0,
        }).run({ task, threadId }),
      ).rejects.toThrow(/budget\.platform_exceeded/);
      expect(queried).toBe(false);
      const run = (await listRuns(db, { taskId: task.taskId })).runs[0]!;
      expect(run.status).toBe("failed");
    });

    it("records spend from a sandbox CLI JSON result of the same SDK shape", async () => {
      const { createTask, getRoutineSpendUsd } = await import("@oikonomos/db");
      const task = await createTask(db, {
        roleId,
        title: "TASK-163 sandbox spend",
        goal: "Sandbox turn.",
        requestedBy: "task-163-suite",
        routineId,
      });
      const previousBrokerUrl = process.env.OIK_SANDBOX_BROKER_URL;
      const previousSigningKey = process.env.OIK_SECRET_BROKER_TOKEN_SIGNING_KEY;
      const anthropicVar = ["OIK_SECRET_ANTHROPIC", "API_KEY"].join("_");
      const previousAnthropic = process.env[anthropicVar];
      process.env.OIK_SANDBOX_BROKER_URL = "http://broker.test:3001";
      process.env.OIK_SECRET_BROKER_TOKEN_SIGNING_KEY = "task-163-test-signing-key";
      process.env[anthropicVar] = "task-163-test-anthropic-credential";
      let state: "Running" | "Paused" = "Running";
      const fakeSandbox = {
        health: async () => ({ status: "ok" as const }),
        createSandbox: async () => ({ id: "task-163-office", createdAt: "2026-09-07T00:00:00Z", status: { state } }),
        getSandbox: async () => ({ id: "task-163-office", createdAt: "2026-09-07T00:00:00Z", status: { state } }),
        destroySandbox: async () => undefined,
        pauseSandbox: async () => { state = "Paused"; },
        resumeSandbox: async () => { state = "Running"; },
        getEndpoint: async () => ({ endpoint: "http://execd.test/163" }),
        ping: async () => undefined,
        runCommand: async (_endpoint: unknown, command: { command: string }) => {
          if (command.command.startsWith("/usr/bin/sha256sum")) {
            return {
              stdout: "886c6ad71724d395fd4600dd8cc0625df68686808409d6657fab8e9737083854  /etc/claude-code/managed-settings.json\n",
              stderr: "",
              exitCode: 0,
            };
          }
          if (command.command === "test -f /run/oikonomos/egress-policy-applied") {
            return { stdout: "", stderr: "", exitCode: 0 };
          }
          if (command.command.startsWith("mkdir")) {
            return { stdout: "", stderr: "", exitCode: 0 };
          }
          return {
            stdout: JSON.stringify({
              type: "result",
              subtype: "success",
              result: "sandbox spend recorded",
              total_cost_usd: 0.15,
              modelUsage: {
                "claude-haiku-4-5-20251001": {
                  inputTokens: 40,
                  outputTokens: 10,
                  cacheReadInputTokens: 0,
                  cacheCreationInputTokens: 0,
                },
              },
            }),
            stderr: "",
            exitCode: 0,
          };
        },
      };
      try {
        await createChatRunDriver({
          ...db,
          manifests: [],
          sandboxClient: fakeSandbox as SandboxClient,
          platformCeilingZar: 1_000_000,
        }).run({ task, threadId });
        // 0.25 from the local-path test + 0.15 from this sandbox turn.
        expect(await getRoutineSpendUsd(db, routineId)).toBeCloseTo(0.4);
      } finally {
        if (previousBrokerUrl === undefined) delete process.env.OIK_SANDBOX_BROKER_URL;
        else process.env.OIK_SANDBOX_BROKER_URL = previousBrokerUrl;
        if (previousSigningKey === undefined) delete process.env.OIK_SECRET_BROKER_TOKEN_SIGNING_KEY;
        else process.env.OIK_SECRET_BROKER_TOKEN_SIGNING_KEY = previousSigningKey;
        if (previousAnthropic === undefined) delete process.env[anthropicVar];
        else process.env[anthropicVar] = previousAnthropic;
      }
    });

    it("releases the office in a finally when the Claude lane's sandboxed command throws (TASK-296 AC3/4)", async () => {
      const { createTask, getRoleSandbox } = await import("@oikonomos/db");
      const task = await createTask(db, {
        roleId,
        title: "TASK-296 release-on-failure",
        goal: "This turn fails mid-command.",
        requestedBy: "task-296-suite",
        routineId,
      });
      const previousBrokerUrl = process.env.OIK_SANDBOX_BROKER_URL;
      const previousSigningKey = process.env.OIK_SECRET_BROKER_TOKEN_SIGNING_KEY;
      const anthropicVar = ["OIK_SECRET_ANTHROPIC", "API_KEY"].join("_");
      const previousAnthropic = process.env[anthropicVar];
      process.env.OIK_SANDBOX_BROKER_URL = "http://broker.test:3001";
      process.env.OIK_SECRET_BROKER_TOKEN_SIGNING_KEY = "task-296-test-signing-key";
      process.env[anthropicVar] = "task-296-test-anthropic-credential";
      let state: "Running" | "Paused" = "Running";
      let pauseCalls = 0;
      const fakeSandbox = {
        health: async () => ({ status: "ok" as const }),
        createSandbox: async () => ({ id: "task-296-office", createdAt: "2026-09-18T00:00:00Z", status: { state } }),
        getSandbox: async () => ({ id: "task-296-office", createdAt: "2026-09-18T00:00:00Z", status: { state } }),
        destroySandbox: async () => undefined,
        pauseSandbox: async () => { pauseCalls += 1; state = "Paused"; },
        resumeSandbox: async () => { state = "Running"; },
        getEndpoint: async () => ({ endpoint: "http://execd.test/296" }),
        ping: async () => undefined,
        runCommand: async (_endpoint: unknown, command: { command: string }) => {
          if (command.command.startsWith("/usr/bin/sha256sum")) {
            return {
              stdout: "886c6ad71724d395fd4600dd8cc0625df68686808409d6657fab8e9737083854  /etc/claude-code/managed-settings.json\n",
              stderr: "",
              exitCode: 0,
            };
          }
          if (command.command === "test -f /run/oikonomos/egress-policy-applied") return { stdout: "", stderr: "", exitCode: 0 };
          if (command.command.startsWith("mkdir")) return { stdout: "", stderr: "", exitCode: 0 };
          // The real turn command — simulate a network/execd failure mid-turn.
          // Before TASK-296, `pauseSandbox` sat after this call AND after the
          // exit-code check, so a throw here skipped release entirely and
          // left the office Running until the reaper's idle sweep eventually
          // caught it, possibly days later.
          throw new Error("simulated execd network failure");
        },
      };
      try {
        await expect(
          createChatRunDriver({
            ...db,
            manifests: [],
            sandboxClient: fakeSandbox as SandboxClient,
            platformCeilingZar: 1_000_000,
          }).run({ task, threadId }),
        ).rejects.toThrow("simulated execd network failure");
        expect(pauseCalls).toBe(1);
        expect((await getRoleSandbox(db, roleId))?.state).toBe("Paused");
      } finally {
        if (previousBrokerUrl === undefined) delete process.env.OIK_SANDBOX_BROKER_URL;
        else process.env.OIK_SANDBOX_BROKER_URL = previousBrokerUrl;
        if (previousSigningKey === undefined) delete process.env.OIK_SECRET_BROKER_TOKEN_SIGNING_KEY;
        else process.env.OIK_SECRET_BROKER_TOKEN_SIGNING_KEY = previousSigningKey;
        if (previousAnthropic === undefined) delete process.env[anthropicVar];
        else process.env[anthropicVar] = previousAnthropic;
      }
    });
  });
}

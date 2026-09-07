import {
  issueApproval,
  verifyAndConsume,
  type ConsumeDependencies,
  type IssueApprovalDependencies,
} from "@oikonomos/approvals";
import { type DecisionAuditEvent } from "@oikonomos/audit";
import {
  resolveCapabilityTier,
  riskTiers,
  type EnforcedActionClass,
  type RequireApprovalRule,
  type TargetValue,
  type CapabilityTier,
  type RiskTier,
} from "@oikonomos/policy";
import { actionDigest, type JsonValue } from "@oikonomos/shared";

import {
  recheckAgainstManifest,
  type ManifestMap,
} from "./recheck.js";
import { resolveEnforcementGate } from "./enforcementGate.js";
import { RefusalMemory } from "./refusalMemory.js";
import { guardSecretPath } from "./secretPathGuard.js";
import { guardSteelSessionSafety } from "./steelSessionGuard.js";
import {
  builtinDescribers,
  describeOrDeny,
  DESCRIBE_DENIED_AUDIT_TYPE,
  type DescriberRegistry,
} from "./describe.js";
import { describeRequestSecret, REQUEST_SECRET_TOOL } from "./requestSecret.js";

export {
  providerCapEnvVar,
  resolveBudgetGate,
  resolveProviderCapUsd,
  type BudgetGateDecision,
  type BudgetGateDenyReason,
  type BudgetGateInput,
  type ProviderBudgetInput,
} from "./budgetGate.js";

export const workspaceName = "broker";

export {
  PolicyMissingError,
  PolicyRegistry,
  StalePolicyEntryError,
  type PolicyRegistryInput,
  type ToolPolicyEntry,
} from "./registry.js";
export {
  CapabilityRegistry,
  CapabilityNotRegisteredError,
  CapabilityOwnershipError,
  CapabilityTierDriftError,
  DuplicateToolDeclarationError,
  InvalidToolDeclarationError,
  StaleCapabilityRowError,
  UnobservableCapabilityRegistryError,
  declaredToolsFromManifest,
  type CapabilityRegistryBuildInput,
  type ConnectorManifestSlice,
  type DeclaredTool,
  type PersistedCapability,
  type PersistedCapabilityReader,
  type PersistedRoleGrant,
} from "./capabilityRegistry.js";
export { BUILTIN_TOOLS } from "./builtinTools.js";
export {
  mintBrokerToken,
  verifyBrokerToken,
  BROKER_TOKEN_SIGNING_KEY_REF,
  BROKER_TOKEN_SIGNING_KEY_ENV,
  resolveBrokerTokenSigningKey,
  type BrokerTokenBinding,
  type VerifiedBrokerToken,
} from "./brokerToken.js";
export {
  describeRequestSecret,
  parseRequestSecretInput,
  REQUEST_SECRET_CAPABILITY_ID,
  REQUEST_SECRET_LABEL_MAX_CHARS,
  REQUEST_SECRET_PURPOSE_MAX_CHARS,
  REQUEST_SECRET_TOOL,
  type RequestSecretInput,
} from "./requestSecret.js";
export {
  ALLOWLIST_MISS_REASON,
  recheckAgainstManifest,
  type ManifestMap,
  type RecheckDecision,
} from "./recheck.js";
export {
  APPROVAL_TIER as DESCRIBE_APPROVAL_TIER,
  builtinDescribers,
  describeOrDeny,
  describeToolCall,
  formatDescribedAction,
  DESCRIBE_DENIED_AUDIT_TYPE,
  TARGET_MAX_CHARS,
  type ActionDescription,
  type Describer,
  type DescriberRegistry,
  type ToolCall,
} from "./describe.js";

/** Handover §4.1 request contract for POST /v1/broker/pretooluse. */
export interface PreToolUseRequest {
  toolUseId: string;
  runId: string;
  roleId: string;
  tenantId: string;
  toolName: string;
  input: Record<string, unknown>;
  agentRef: { provider: string; sessionRef: string; isSubagent: boolean };
  approvalNonce?: string;
}

/** Handover §4.1 response contract — exactly one shape is returned. */
export type PreToolUseResponse =
  | { decision: "allow"; tier: RiskTier; auditEventId: string; updatedInput?: Record<string, unknown> }
  | { decision: "deny"; reason: string; auditEventId: string }
  | { decision: "deny"; reason: "approval_pending"; approvalId: string; auditEventId: string };

export interface RegisteredCapability extends CapabilityTier {
  capabilityId: string;
  /** Enables Addendum F enforcement for capabilities migrated to its map. */
  enforcementEnabled?: boolean;
  /** Fixed-floor classifications declared by the capability/manifest. */
  enforcedActionClasses?: readonly EnforcedActionClass[];
}

/**
 * `role_grants.max_tier` retains its persisted ceiling semantics at this
 * boundary. It is deliberately not named `roleGrantOverride`: policy's
 * override is a restrictive floor, whereas this value is an allowed maximum.
 */
export interface RoleGrantCeiling {
  maxTier: RiskTier;
}

export interface BrokerDependencies {
  /** Read for every request: a runtime kill switch must never be cached. */
  isCapabilitiesEnabled(): boolean | Promise<boolean>;
  getCapability(toolName: string): Promise<RegisteredCapability | null>;
  getRoleGrant(roleId: string, capabilityId: string): Promise<RoleGrantCeiling | null>;
  /** Persisted role/tenant rules, supplied by the OIK-200 query layer. */
  getRequireApprovalRules?(request: PreToolUseRequest): Promise<readonly RequireApprovalRule[]>;
  /** Per-run memory from TASK-073; a default is retained per composition. */
  refusalMemory?: RefusalMemory;
  destinationFor(request: PreToolUseRequest): string;
  /** Real @oikonomos/approvals ports; do not substitute a locally-shaped API. */
  issueApproval: typeof issueApproval;
  verifyAndConsume: typeof verifyAndConsume;
  issueApprovalDependencies: IssueApprovalDependencies;
  consumeDependencies: ConsumeDependencies;
  recordDecision(event: DecisionAuditEvent): Promise<{ eventId: string }>;
  /**
   * Derived allowedTools / connector-manifest map (study §Tier 1.6).
   * When provided, every PreToolUse call is re-checked against this map
   * before the rest of L1; a miss denies `allowlist.miss` even if the
   * tool still appears on the mounted tool list. Optional so existing L1
   * tests remain byte-identical; production callers construct a
   * {@link CapabilityRegistry} (which validates declaration/persistence
   * closure) plus a {@link PolicyRegistry} (which validates mounted-tool
   * completeness), then pass the latter's
   * `manifestMap`.
   */
  manifestMap?: ManifestMap;
  /**
   * Whitelist describers for the TASK-067/194 describe-or-deny gate.
   * When omitted, {@link builtinDescribers} is used. An empty registry
   * is fail-closed (every tool is undescribable) — omitting the field
   * is not the same as passing `{}`.
   */
  describers?: DescriberRegistry;
}

const APPROVAL_TIER: RiskTier = "T3_external";
const AUDIT_UNAVAILABLE_EVENT_ID = "unavailable";
// ADR-007 §2.4a: this bounds the L1 PreToolUse-to-L3 canUseTool handoff, not
// the independent 10-second broker response deadline from ADR-001 R3.
const L1_TO_L3_REPLAY_WINDOW_MS = 60_000;
const REPLAY_CACHE_MAX_ENTRIES = 1_024;

/**
 * The HTTP adapter (OIK-084) maps timeout, non-2xx, and invalid JSON failures
 * to this error before they reach the broker. Keeping it typed prevents a
 * transport failure from accidentally becoming an unhandled rejection.
 */
export class BrokerFailure extends Error {
  public constructor(
    public readonly reason: "broker.timeout" | "broker.http_500" | "broker.malformed_response",
  ) {
    super(reason);
    this.name = "BrokerFailure";
  }
}

class AuditUnavailableError extends Error {
  public constructor() {
    super("audit.write_failed");
    this.name = "AuditUnavailableError";
  }
}

interface ReplayEntry {
  response: Promise<PreToolUseResponse>;
  readonly expiresAt: number;
  settled: boolean;
}

/**
 * One replay cache per dependency composition; WeakMap avoids retaining a
 * service on teardown. Entries are scoped by tenant, role, toolUseId,
 * toolName, and actionDigest({toolName, input, destination}) (ADR-007 §3a),
 * expire after the ADR-007 L1-to-L3 replay window, and use safe LRU eviction.
 */
const replayCaches = new WeakMap<BrokerDependencies, Map<string, ReplayEntry>>();
const refusalMemories = new WeakMap<BrokerDependencies, RefusalMemory>();

function refusalMemoryFor(dependencies: BrokerDependencies): RefusalMemory {
  if (dependencies.refusalMemory !== undefined) return dependencies.refusalMemory;
  let memory = refusalMemories.get(dependencies);
  if (memory === undefined) {
    memory = new RefusalMemory();
    refusalMemories.set(dependencies, memory);
  }
  return memory;
}

function tierRank(tier: RiskTier): number {
  return riskTiers.indexOf(tier);
}

function exceedsCeiling(defaultTier: RiskTier, ceiling: RiskTier): boolean {
  return tierRank(defaultTier) > tierRank(ceiling);
}

function actionFor(request: PreToolUseRequest, destination: string) {
  return {
    toolName: request.toolName,
    // The Handover request contract intentionally permits unknown values.
    // @oikonomos/shared remains the single runtime validator/canonicalizer.
    input: request.input as JsonValue,
    destination,
  };
}

async function audit(
  dependencies: BrokerDependencies,
  request: PreToolUseRequest,
  event: Omit<DecisionAuditEvent, "actor" | "runId" | "tenantId">,
): Promise<string> {
  try {
    const persisted = await dependencies.recordDecision({
      ...event,
      actor: `agent:${request.agentRef.provider}`,
      runId: request.runId,
      tenantId: request.tenantId,
      payload: {
        ...event.payload,
        toolUseId: request.toolUseId,
        toolName: request.toolName,
        sessionRef: request.agentRef.sessionRef,
        isSubagent: request.agentRef.isSubagent,
      },
    });
    return persisted.eventId;
  } catch {
    // This failure cannot be audited through the same broken writer. The
    // caller must still deny, with an explicit non-event ID for observability.
    throw new AuditUnavailableError();
  }
}

async function deny(
  dependencies: BrokerDependencies,
  request: PreToolUseRequest,
  reason: string,
  capability: string | null = null,
  tier: RiskTier | null = null,
  payload?: Record<string, unknown>,
): Promise<PreToolUseResponse> {
  return {
    decision: "deny",
    reason,
    auditEventId: await audit(dependencies, request, {
      verdict: "deny",
      reason,
      capability,
      tier,
      payload,
    }),
  };
}

function isCapability(value: unknown): value is RegisteredCapability {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RegisteredCapability>;
  return typeof candidate.capabilityId === "string"
    && typeof candidate.toolName === "string"
    && typeof candidate.defaultTier === "string"
    && riskTiers.includes(candidate.defaultTier as RiskTier);
}

function isRoleGrant(value: unknown): value is RoleGrantCeiling {
  return typeof value === "object"
    && value !== null
    && typeof (value as Partial<RoleGrantCeiling>).maxTier === "string"
    && riskTiers.includes((value as RoleGrantCeiling).maxTier);
}

function failureReason(error: unknown): string {
  if (error instanceof BrokerFailure) return error.reason;
  return "broker.dependency_failure";
}

function replayKey(request: PreToolUseRequest, destination: string): string {
  // ADR-007 §3a: the cache in front of authorisation is keyed on the full
  // decision input, not only the requester. N10: one digest implementation.
  const digest = actionDigest({
    toolName: request.toolName,
    input: request.input as JsonValue,
    destination,
  });
  return `${request.tenantId}\0${request.roleId}\0${request.toolUseId}\0${request.toolName}\0${digest}`;
}

async function failClosed(
  dependencies: BrokerDependencies,
  request: PreToolUseRequest,
  reason: string,
): Promise<PreToolUseResponse> {
  try {
    return await deny(dependencies, request, reason);
  } catch (error) {
    if (!(error instanceof AuditUnavailableError)) throw error;
    return { decision: "deny", reason, auditEventId: AUDIT_UNAVAILABLE_EVENT_ID };
  }
}

/**
 * Approval-required path: describe-or-deny first, then consume or issue.
 * Both the legacy T3+ branch and the Addendum F enforced-class branch
 * funnel through here so an undescribable tool cannot reach issueApproval
 * on either site. MUTATION target: dropping the describeOrDeny call lets
 * an unknown tool park as approval_pending and reddens index.test.ts.
 */
async function resolveApprovalRequired(
  request: PreToolUseRequest,
  dependencies: BrokerDependencies,
  destination: string,
  capability: RegisteredCapability,
  tier: RiskTier,
  auditPayload?: Record<string, unknown>,
): Promise<PreToolUseResponse> {
  const described = describeOrDeny(
    {
      toolName: request.toolName,
      input: request.input,
      destination,
    },
    {
      describers: dependencies.describers ?? {
        ...builtinDescribers,
        [REQUEST_SECRET_TOOL]: describeRequestSecret,
      },
      tier,
    },
  );
  if (described.decision === "deny") {
    return deny(
      dependencies,
      request,
      described.code,
      capability.capabilityId,
      tier,
      {
        type: DESCRIBE_DENIED_AUDIT_TYPE,
        code: described.code,
        ...auditPayload,
      },
    );
  }

  const action = actionFor(request, destination);
  if (request.approvalNonce !== undefined) {
    const consumed = await dependencies.verifyAndConsume(
      request.approvalNonce,
      dependencies.consumeDependencies,
      action,
    );
    if (consumed.consumed) {
      return {
        decision: "allow",
        tier,
        auditEventId: await audit(dependencies, request, {
          verdict: "allow",
          capability: capability.capabilityId,
          tier,
          ...(auditPayload !== undefined ? { payload: auditPayload } : {}),
        }),
      };
    }
    return deny(
      dependencies,
      request,
      "approval.not_granted",
      capability.capabilityId,
      tier,
      auditPayload,
    );
  }

  // ADR-004: only canonical payload fields are supplied; approvals derives render itself.
  const pending = await dependencies.issueApproval(
    {
      runId: request.runId,
      capabilityId: capability.capabilityId,
      toolName: action.toolName,
      input: action.input,
      destination: action.destination,
      tenantId: request.tenantId,
    },
    dependencies.issueApprovalDependencies,
  );
  return {
    decision: "deny",
    reason: "approval_pending",
    approvalId: pending.approvalId,
    auditEventId: await audit(dependencies, request, {
      verdict: "require_approval",
      capability: capability.capabilityId,
      tier,
      ...(auditPayload !== undefined ? { payload: auditPayload } : {}),
    }),
  };
}

/**
 * L1 broker decision handler. HTTP adaptation belongs to OIK-084; this
 * function composes policy, approvals, and audit without adding a framework.
 */
export async function handlePreToolUse(
  request: PreToolUseRequest,
  dependencies: BrokerDependencies,
): Promise<PreToolUseResponse> {
  let cache = replayCaches.get(dependencies);
  if (cache === undefined) {
    cache = new Map();
    replayCaches.set(dependencies, cache);
  }
  let key: string;
  let destination: string;
  try {
    // Destination is part of the decision input, so it must be resolved
    // before the cache lookup — otherwise a payload swap reuses an allow.
    destination = dependencies.destinationFor(request);
    key = replayKey(request, destination);
  } catch (error) {
    return failClosed(dependencies, request, failureReason(error));
  }
  const replay = cache.get(key);
  if (replay !== undefined) {
    // An in-flight decision is always replayed, even if the nominal handoff
    // window passes: evicting it would split one tool use into two decisions.
    if (!replay.settled || replay.expiresAt > Date.now()) {
      // Refresh insertion order so the Map acts as an LRU cache.
      cache.delete(key);
      cache.set(key, replay);
      return replay.response;
    }
    cache.delete(key);
  }

  const decision = decidePreToolUse(request, dependencies, destination);
  const entry: ReplayEntry = {
    response: decision,
    expiresAt: Date.now() + L1_TO_L3_REPLAY_WINDOW_MS,
    settled: false,
  };
  entry.response = decision.finally(() => {
    entry.settled = true;
  });

  // Never evict an in-flight request: that would make a repeated toolUseId
  // recompute concurrently. A burst of >1,024 simultaneous requests may
  // temporarily exceed the settled-entry cap, then contracts safely.
  for (const [oldestKey, oldestEntry] of cache) {
    if (cache.size < REPLAY_CACHE_MAX_ENTRIES) break;
    if (oldestEntry.settled) cache.delete(oldestKey);
  }
  cache.set(key, entry);
  return entry.response;
}

async function decidePreToolUse(
  request: PreToolUseRequest,
  dependencies: BrokerDependencies,
  destination: string,
): Promise<PreToolUseResponse> {
  try {
    if (!await dependencies.isCapabilitiesEnabled()) {
      return deny(dependencies, request, "capability.disabled");
    }

    // N13 is a fixed-floor gate. It deliberately precedes the six-rank
    // resolver, so grants, allow rules, and autonomous resolution cannot
    // make a D3 target executable. destinationFor is the real target
    // resolver used by this PreToolUse path.
    const secretPathDecision = guardSecretPath(destination);
    if (secretPathDecision.decision === "deny") {
      return deny(
        dependencies,
        request,
        secretPathDecision.reason,
        null,
        null,
        { ...secretPathDecision.auditEvent },
      );
    }

    // Non-negotiable #6, same fixed-floor shape as the D3 guard above: a
    // steel_session_create call requesting CAPTCHA solving, a proxy, a
    // persisted profile, or a namespace is denied before grants/tiers/allow
    // rules are ever consulted (TASK-207 Blocking-2).
    const steelSessionDecision = guardSteelSessionSafety(request.toolName, request.input);
    if (steelSessionDecision.decision === "deny") {
      return deny(
        dependencies,
        request,
        steelSessionDecision.reason,
        null,
        null,
        { ...steelSessionDecision.auditEvent },
      );
    }

    // Call-time re-check against the derived allowedTools/manifest map
    // (study §Tier 1.6). MUTATION target: removing this block lets a
    // stale-tool-list invocation fall through to L1 and turns the
    // MUTATION-PROVEN test red.
    if (dependencies.manifestMap !== undefined) {
      const recheck = recheckAgainstManifest(request.toolName, dependencies.manifestMap);
      if (recheck.decision === "deny") {
        return deny(dependencies, request, recheck.reason);
      }
    }

  const capability = await dependencies.getCapability(request.toolName);
  if (capability === null) {
    return deny(dependencies, request, "capability.unregistered");
  }
  if (!isCapability(capability)) {
    return deny(dependencies, request, "broker.malformed_response");
  }

  const roleGrant = await dependencies.getRoleGrant(request.roleId, capability.capabilityId);
  if (roleGrant === null) {
    return deny(
      dependencies,
      request,
      "role.grant_missing",
      capability.capabilityId,
      capability.defaultTier,
    );
  }
  if (!isRoleGrant(roleGrant)) {
    return deny(dependencies, request, "broker.malformed_response", capability.capabilityId, capability.defaultTier);
  }
  const resolution = resolveCapabilityTier({
    toolName: request.toolName,
    capabilities: [capability],
  });
  if (resolution.decision === "deny") {
    return deny(dependencies, request, resolution.reason);
  }

  const { tier } = resolution;
  // Legacy capability declarations have no enforcement classification yet.
  // Preserve their established L1 behaviour until their registry entry opts
  // into the Addendum F map; migrated entries always use the gate below.
  if (capability.enforcementEnabled !== true) {
    if (exceedsCeiling(capability.defaultTier, roleGrant.maxTier)) {
      return deny(
        dependencies,
        request,
        "role.tier_ceiling",
        capability.capabilityId,
        capability.defaultTier,
      );
    }
    if (tier === "T4_irreversible") {
      return deny(dependencies, request, "tier.irreversible", capability.capabilityId, tier);
    }
    if (tierRank(tier) < tierRank(APPROVAL_TIER)) {
      return {
        decision: "allow",
        tier,
        auditEventId: await audit(dependencies, request, {
          verdict: "allow",
          capability: capability.capabilityId,
          tier,
        }),
      };
    }
    return await resolveApprovalRequired(request, dependencies, destination, capability, tier);
  }

  const remembered = (dependencies.refusalMemory ?? refusalMemoryFor(dependencies)).consult({
    runId: request.runId,
    tool: request.toolName,
    // TASK-073 keys the declared action target, not the approval's derived
    // action object. Keep this identity byte-for-byte aligned with callers
    // that recorded the original request before a later grant widening.
    target: request.input as JsonValue,
  });
  // TASK-073 is consulted before an approval can be re-issued. This preserves
  // its per-run "do not re-ask" contract even when the original action is a
  // fixed-floor class that would otherwise park again at rank 2.
  if (remembered.decision === "deny") {
    return deny(dependencies, request, remembered.code, capability.capabilityId, tier);
  }
  const enforcement = resolveEnforcementGate({
    capabilityId: capability.capabilityId,
    target: request.input as Readonly<Record<string, TargetValue>>,
    actionClasses: capability.enforcedActionClasses ?? [],
    requireApprovalRules: await dependencies.getRequireApprovalRules?.(request) ?? [],
    refusalMemoryHit: false,
    // ADR-003's ceiling remains a restriction; it is now rank 5, not a deny.
    roleGrantCeilingExceeded: exceedsCeiling(capability.defaultTier, roleGrant.maxTier),
  });

  if (enforcement.enforcementClass === "denied") {
    return deny(dependencies, request, "refusal.abandoned", capability.capabilityId, tier);
  }

  if (enforcement.enforcementClass === "autonomous") {
    return {
      decision: "allow",
      tier,
      auditEventId: await audit(dependencies, request, {
        verdict: "allow",
        capability: capability.capabilityId,
        tier,
        payload: {
          enforcementClass: enforcement.enforcementClass,
          enforcementRank: enforcement.rank,
        },
      }),
    };
  }

  if (capability.enforcedActionClasses?.includes("E2_auth_security_friction") === true) {
    return {
      decision: "deny",
      reason: "human.takeover",
      auditEventId: await audit(dependencies, request, {
        verdict: "deny",
        reason: "human.takeover",
        capability: capability.capabilityId,
        tier,
        payload: {
          enforcementClass: enforcement.enforcementClass,
          enforcementRank: enforcement.rank,
          takeover: true,
        },
      }),
    };
  }

  return await resolveApprovalRequired(
    request,
    dependencies,
    destination,
    capability,
    tier,
    {
      enforcementClass: enforcement.enforcementClass,
      enforcementRank: enforcement.rank,
    },
  );
  } catch (error) {
    if (error instanceof AuditUnavailableError) {
      return {
        decision: "deny",
        reason: "audit.write_failed",
        auditEventId: AUDIT_UNAVAILABLE_EVENT_ID,
      };
    }
    return failClosed(dependencies, request, failureReason(error));
  }
}

/** Concrete adapters for callers that already compose the package dependencies. */
export const approvalOperations = { issueApproval, verifyAndConsume };

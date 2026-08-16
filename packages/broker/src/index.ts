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
  type CapabilityTier,
  type RiskTier,
} from "@oikonomos/policy";
import type { JsonValue } from "@oikonomos/shared";

export const workspaceName = "broker";

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
  destinationFor(request: PreToolUseRequest): string;
  /** Real @oikonomos/approvals ports; do not substitute a locally-shaped API. */
  issueApproval: typeof issueApproval;
  verifyAndConsume: typeof verifyAndConsume;
  issueApprovalDependencies: IssueApprovalDependencies;
  consumeDependencies: ConsumeDependencies;
  recordDecision(event: DecisionAuditEvent): Promise<{ eventId: string }>;
}

const APPROVAL_TIER: RiskTier = "T3_external";
const AUDIT_UNAVAILABLE_EVENT_ID = "unavailable";

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

/** One replay cache per dependency composition; WeakMap avoids retaining a service on teardown. */
const replayCaches = new WeakMap<BrokerDependencies, Map<string, Promise<PreToolUseResponse>>>();

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
): Promise<PreToolUseResponse> {
  return {
    decision: "deny",
    reason,
    auditEventId: await audit(dependencies, request, {
      verdict: "deny",
      reason,
      capability,
      tier,
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
  const replay = cache.get(request.toolUseId);
  if (replay !== undefined) return replay;

  const decision = decidePreToolUse(request, dependencies);
  cache.set(request.toolUseId, decision);
  return decision;
}

async function decidePreToolUse(
  request: PreToolUseRequest,
  dependencies: BrokerDependencies,
): Promise<PreToolUseResponse> {
  try {
    if (!await dependencies.isCapabilitiesEnabled()) {
      return deny(dependencies, request, "capability.disabled");
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
  // ADR-003: max_tier is a ceiling, not policy's floor-shaped override.
  if (exceedsCeiling(capability.defaultTier, roleGrant.maxTier)) {
    return deny(
      dependencies,
      request,
      "role.tier_ceiling",
      capability.capabilityId,
      capability.defaultTier,
    );
  }

  const resolution = resolveCapabilityTier({
    toolName: request.toolName,
    capabilities: [capability],
  });
  if (resolution.decision === "deny") {
    return deny(dependencies, request, resolution.reason);
  }

  const { tier } = resolution;
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

  const destination = dependencies.destinationFor(request);
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
        }),
      };
    }
    return deny(dependencies, request, "approval.not_granted", capability.capabilityId, tier);
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
    }),
  };
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

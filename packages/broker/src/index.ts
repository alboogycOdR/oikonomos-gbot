import {
  issueApproval,
  verifyAndConsume,
  type ApprovalWaitSignal,
  type IssueApprovalRequest,
  type VerifyAndConsumeResult,
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
  getCapability(toolName: string): Promise<RegisteredCapability | null>;
  getRoleGrant(roleId: string, capabilityId: string): Promise<RoleGrantCeiling | null>;
  destinationFor(request: PreToolUseRequest): string;
  issueApproval(request: IssueApprovalRequest): Promise<ApprovalWaitSignal>;
  verifyAndConsume(
    nonce: string,
    action: { toolName: string; input: JsonValue; destination: string },
  ): Promise<VerifyAndConsumeResult>;
  recordDecision(event: DecisionAuditEvent): Promise<{ eventId: string }>;
}

const APPROVAL_TIER: RiskTier = "T3_external";

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

/**
 * L1 broker decision handler. HTTP adaptation belongs to OIK-084; this
 * function composes policy, approvals, and audit without adding a framework.
 */
export async function handlePreToolUse(
  request: PreToolUseRequest,
  dependencies: BrokerDependencies,
): Promise<PreToolUseResponse> {
  const capability = await dependencies.getCapability(request.toolName);
  if (capability === null) {
    return deny(dependencies, request, "capability.unregistered");
  }

  const roleGrant = await dependencies.getRoleGrant(request.roleId, capability.capabilityId);
  // ADR-003: max_tier is a ceiling, not policy's floor-shaped override.
  if (roleGrant !== null && exceedsCeiling(capability.defaultTier, roleGrant.maxTier)) {
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
    const consumed = await dependencies.verifyAndConsume(request.approvalNonce, action);
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
  const pending = await dependencies.issueApproval({
    runId: request.runId,
    capabilityId: capability.capabilityId,
    toolName: action.toolName,
    input: action.input,
    destination: action.destination,
    tenantId: request.tenantId,
  });
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
}

/** Concrete adapters for callers that already compose the package dependencies. */
export const approvalOperations = { issueApproval, verifyAndConsume };

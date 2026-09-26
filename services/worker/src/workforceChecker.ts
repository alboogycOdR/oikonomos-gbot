import {
  getLatestAuditEvent,
  getOrCreateThreadForRole,
  getWorkforceEventCounts,
  insertAuditEvent,
  insertMessage,
  type DatabaseOptions,
  type WorkforceEventCount,
} from "@oikonomos/db";

export const WORKFORCE_ALERT_EVENT_TYPE = "workforce.alert";
const WORKFORCE_WINDOW_MS = 60 * 60 * 1_000;

export interface WorkforceCheckOptions extends DatabaseOptions {
  tenantId: string;
  /** Explicit seams keep the checker deterministic in tests and operations. */
  thresholds?: Partial<WorkforceThresholds>;
}

export interface WorkforceThresholds {
  capOrDepth: number;
  duplicates: number;
  deliveryFailures: number;
  groupMessages: number;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function workforceThresholds(overrides: Partial<WorkforceThresholds> = {}): WorkforceThresholds {
  return {
    capOrDepth: overrides.capOrDepth ?? positiveInteger(process.env.OIK_WORKFORCE_CAP_OR_DEPTH_THRESHOLD, 3),
    duplicates: overrides.duplicates ?? positiveInteger(process.env.OIK_WORKFORCE_DUPLICATE_THRESHOLD, 20),
    deliveryFailures: overrides.deliveryFailures ?? positiveInteger(process.env.OIK_WORKFORCE_DELIVERY_FAILURE_THRESHOLD, 10),
    groupMessages: overrides.groupMessages ?? positiveInteger(process.env.OIK_WORKFORCE_GROUP_MESSAGE_THRESHOLD, 60),
  };
}

function sourceKind(category: WorkforceEventCount["category"]): "thread" | "role" {
  return category === "group.cap_reached" || category === "group.message_count" ? "thread" : "role";
}

function thresholdFor(category: WorkforceEventCount["category"], thresholds: WorkforceThresholds): number {
  switch (category) {
    case "group.cap_reached":
    case "role_message.depth_capped": return thresholds.capOrDepth;
    case "role_message.duplicate": return thresholds.duplicates;
    case "role_message.delivery_failed": return thresholds.deliveryFailures;
    case "group.message_count": return thresholds.groupMessages;
  }
}

function alertActor(kind: "thread" | "role", sourceId: string): string {
  return `system:workforce-checker:${kind}:${sourceId}`;
}

function alertBody(category: WorkforceEventCount["category"], count: number): string {
  return `Workforce checker: ${category} observed ${count} time${count === 1 ? "" : "s"} in the last hour.`;
}

/**
 * A zero-inference safety watch. It only reads durable database state and
 * posts category/count notices; no provider or model dependency is accepted.
 */
export async function runWorkforceCheck(options: WorkforceCheckOptions, now = new Date()): Promise<number> {
  if (options.tenantId.trim().length === 0) throw new Error("tenantId must not be empty.");
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("now must be a valid Date.");
  const thresholds = workforceThresholds(options.thresholds);
  const since = new Date(now.getTime() - WORKFORCE_WINDOW_MS);
  const counts = await getWorkforceEventCounts(options, { tenantId: options.tenantId, since });
  let alerted = 0;

  for (const count of counts) {
    if (count.count < thresholdFor(count.category, thresholds)) continue;
    const kind = sourceKind(count.category);
    const actor = alertActor(kind, count.sourceId);
    const recent = await getLatestAuditEvent(options, WORKFORCE_ALERT_EVENT_TYPE, options.tenantId, actor);
    if (recent !== null && recent.at.getTime() >= since.getTime()) continue;

    const threadId = kind === "thread"
      ? count.sourceId
      : (await getOrCreateThreadForRole(options, { roleId: count.sourceId })).id;
    await insertMessage(options, { threadId, role: "system", body: alertBody(count.category, count.count) });
    await insertAuditEvent(options, {
      tenantId: options.tenantId,
      actor,
      eventType: WORKFORCE_ALERT_EVENT_TYPE,
      at: now,
      // Keep this audit category-only: the source stays in actor so the
      // hourly idempotency guard remains durable without recording content.
      payload: { category: count.category, count: count.count },
    });
    alerted += 1;
  }
  return alerted;
}

import { createHash } from "node:crypto";

/**
 * TASK-305 (P-6) — the reviewed prose charter a project manager's instructions
 * are seeded from (workspace spec §7.1), and the changes-only status routine's
 * comparison rule (§1.3, §11). Server-side because a route seeds it, not a
 * client screen; the mobile charter template is the bot-level precedent.
 */

/** Spec §7.1 duties, one line each. The test asserts the seeded text contains every one. */
export const MANAGER_CHARTER_DUTIES = [
  "Decompose the goal into work items",
  "Assign each work item to a roster member by responsibility",
  "Check evidence (artifacts, receipts) against each item's done criterion",
  "Mark items review or done only when the evidence meets the criterion",
  "Mark an item blocked with the reason",
  "Regenerate STATUS.md",
  "Escalate to the human only for decisions",
] as const;

export interface ManagerCharterInput {
  projectName: string;
  goal: string;
  doneCriterion: string;
}

export function buildManagerCharter(input: ManagerCharterInput): string {
  return [
    "# Engineering Manager / Chief of Staff",
    "",
    `You manage the project "${input.projectName}".`,
    `Goal: ${input.goal}`,
    `Done when: ${input.doneCriterion}`,
    "",
    "## Your duties",
    ...MANAGER_CHARTER_DUTIES.map((duty, index) => `${index + 1}. ${duty}.`),
    "",
    "## Rules",
    "- Work only through the project tools; register STATUS.md as a project artifact with provenance, never as a chat message.",
    "- If there is nothing new to report, report nothing.",
    "- Bring the human decisions, not progress chatter.",
    "",
    "## Requesting specialists",
    "- If the roster lacks a specialist you need, request one through workspace.create_bot.",
    "- State why the bot is needed in the request, then wait: each request parks for the human's approval.",
    "- Never retry, rename around, or otherwise work around a denial; a denied request is the human's decision.",
    "- Retiring a bot is not available to you; ask the user.",
  ].join("\n");
}

/** Definition stored on the manager's status routine so a run can find its project. */
export const STATUS_ROUTINE_NAME = "Project status";
export const STATUS_ROUTINE_SCHEDULE = "0 8 * * *";

export function statusRoutineDefinition(projectId: string): Record<string, unknown> {
  return { kind: "project_status", projectId, artifact: "STATUS.md" };
}

/** Digest of a STATUS.md body; line endings and trailing whitespace are not changes. */
export function statusDigest(content: string): string {
  const normalized = content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  return createHash("sha256").update(normalized).digest("hex");
}

/** Spec §1.3 / §11: notify only when STATUS.md differs from the last reported one. */
export function statusChanged(lastReportedDigest: string | null, current: string): boolean {
  return lastReportedDigest !== statusDigest(current);
}

export interface StatusRoutineRun {
  readStatus(): Promise<string | null>;
  lastReportedDigest: string | null;
  notify(message: string): Promise<void>;
}

/** One firing of the changes_only status routine. Returns the digest to remember. */
export async function runStatusRoutine(run: StatusRoutineRun): Promise<{ notified: boolean; digest: string | null }> {
  const current = await run.readStatus();
  if (current === null) return { notified: false, digest: run.lastReportedDigest };
  if (!statusChanged(run.lastReportedDigest, current)) {
    return { notified: false, digest: run.lastReportedDigest };
  }
  await run.notify(current);
  return { notified: true, digest: statusDigest(current) };
}

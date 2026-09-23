import type { Role, Skill } from "@oikonomos/db";
import type { MemoryFact } from "@oikonomos/memory";
import type { ContextMessage } from "./contextCompaction.js";

/**
 * TASK-339 — deployment-wide provenance block. Appended by the deployment (inside
 * buildRoleSystemPrompt, which every lane's assembly goes through), so no role's
 * instructions can drop it. Wording v1; the owner may revise it.
 */
export const PROVENANCE_BLOCK =
  "When you state a fact, say where it came from: the tool result, page, file or message you got it from. When something comes from your own general knowledge rather than a source you checked in this conversation, say so plainly. Never invent a source.";

/** Build a useful identity even when an older role has no custom instructions. */
export function buildRoleSystemPrompt(role: Role | null, fallbackRoleId: string): string {
  const name = role?.name ?? fallbackRoleId;
  const title = role?.title ?? name;
  const description = role?.description.trim() ?? "";
  const instructions = role?.instructions?.trim() ?? "";
  const identity = [
    `You are ${name}, serving as ${title}.`,
    description.length === 0 ? "Represent this bot identity clearly and helpfully." : `Your role description: ${description}`,
  ];
  if (instructions.length > 0) identity.push(`Your custom instructions:\n${instructions}`);
  identity.push(PROVENANCE_BLOCK);
  return identity.join("\n\n");
}

/**
 * TASK-177 (G-01b) — a `/name` token in the user's message, matching
 * `packages/db`'s `SKILL_NAME_RE` (`^[a-z0-9][a-z0-9-]{1,63}$`). Requires a
 * preceding start-of-string or whitespace so a URL path segment like
 * `https://x/weekly-export` is never mistaken for a skill invocation.
 * Returns tokens in first-seen order, de-duplicated, so a skill referenced
 * twice in one message is never injected twice (spec: "never duplicates a
 * skill referenced twice").
 */
export function extractSkillTokens(message: string): string[] {
  const re = /(?:^|\s)\/([a-z0-9][a-z0-9-]{1,63})\b/g;
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const match of message.matchAll(re)) {
    const name = match[1];
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    tokens.push(name);
  }
  return tokens;
}

/**
 * Resolve a `/name` token to the skill ENABLED for the run's role, or
 * `null` when the skill does not exist or is not enabled for this role.
 * The worker is the enforcement point (spec: "the enforcement is
 * server-side in the worker, not in the composer UI") — a caller here is
 * expected to check both existence and per-role enablement and collapse
 * both cases to `null`, since a `/name` "not enabled for this role (or
 * non-existent)" is treated identically.
 */
export type SkillResolver = (name: string) => Promise<Skill | null>;

/**
 * Render one `## Skill: name` block: when_to_use, the body (steps /
 * validate / returns are authored markdown inside `body`), and any
 * required approvals. Prompt material only (N12) — nothing here is a
 * policy or authorization decision.
 */
export function formatSkillBlock(skill: Skill): string {
  const lines = [`## Skill: ${skill.name}`];
  if (skill.whenToUse !== null && skill.whenToUse.trim().length > 0) {
    lines.push(`When to use: ${skill.whenToUse.trim()}`);
  }
  lines.push(skill.body.trim());
  if (skill.approvals.length > 0) {
    lines.push(`Approvals required: ${skill.approvals.join(", ")}`);
  }
  return lines.join("\n\n");
}

/**
 * Hard cap on the profile-memory block, in characters (~1,500 tokens at
 * ~4 chars/token). Profile facts are prepended on EVERY turn of BOTH lanes, so
 * an unbounded block would tax every turn's cost and crowd out the thread. The
 * cap is generous for curated charter/preference facts (a few dozen short
 * key/value lines) yet bounded; facts beyond it are dropped whole (never cut
 * mid-fact) and a truncation note names how many were omitted.
 */
export const PROFILE_MEMORY_MAX_CHARS = 6000;

const SCOPE_ORDER: Record<string, number> = { user: 0, agent: 1, project: 2 };

/** Format visible profile-tier facts as one bounded prompt block ("" when none). */
export function formatProfileMemoryBlock(facts: readonly MemoryFact[]): string {
  if (facts.length === 0) return "";
  const sorted = [...facts].sort(
    (a, b) => (SCOPE_ORDER[a.scope] ?? 9) - (SCOPE_ORDER[b.scope] ?? 9) || a.key.localeCompare(b.key),
  );
  const header = "## Profile memory\n\nDurable facts you should rely on (scope: key: value).";
  const lines: string[] = [];
  let used = header.length;
  let omitted = 0;
  for (const fact of sorted) {
    const value = typeof fact.value === "string" ? fact.value : JSON.stringify(fact.value);
    const line = `- [${fact.scope}] ${fact.key}: ${value}`;
    if (used + line.length + 1 > PROFILE_MEMORY_MAX_CHARS) {
      omitted += 1;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  const tail = omitted > 0 ? [`(${omitted} further profile fact(s) omitted: memory block cap reached)`] : [];
  return [header, ...lines, ...tail].join("\n");
}

/**
 * Full system-prompt assembly for a chat turn: the role persona block
 * (unchanged, `buildRoleSystemPrompt`) followed by exactly one `## Skill:
 * name` block per distinct enabled `/name` token referenced in the
 * message, in the order first referenced. A `/name` that resolves to no
 * enabled skill is left as plain text in the user's message (untouched
 * here) and instead surfaces as a system-visible note appended at the end
 * of the system prompt, naming the exact skill that was not available.
 */
export async function assembleSystemPrompt(params: {
  role: Role | null;
  fallbackRoleId: string;
  message: string;
  resolveEnabledSkill: SkillResolver;
  /** Profile-tier facts already filtered by readProfileTier (ACL, expiry, supersession). */
  memoryFacts?: readonly MemoryFact[];
}): Promise<string> {
  const persona = buildRoleSystemPrompt(params.role, params.fallbackRoleId);
  const memory = formatProfileMemoryBlock(params.memoryFacts ?? []);
  const base = memory.length === 0 ? persona : `${persona}\n\n${memory}`;
  const tokens = extractSkillTokens(params.message);
  const blocks: string[] = [];
  const notes: string[] = [];
  for (const name of tokens) {
    const skill = await params.resolveEnabledSkill(name);
    if (skill === null) {
      notes.push(`skill '${name}' is not enabled for this bot`);
      continue;
    }
    blocks.push(formatSkillBlock(skill));
  }
  return [base, ...blocks, ...notes].join("\n\n");
}

/**
 * TASK-179 (G-03a) — full turn assembly: persona → skills → latest summary
 * → verbatim messages after `compacted_through_message_id`. `history` MUST
 * already be scoped to the thread's current epoch and to strictly-after
 * `compactedThroughMessageId` by the caller (`contextCompaction.ts`'s ports
 * do exactly this) — "start fresh" (epoch bump) works by the caller simply
 * never handing this function a pre-fresh message or summary, so a
 * pre-fresh turn can never leak into a post-fresh prompt (spec AC: "the
 * assembled prompt contains zero pre-fresh messages or summaries").
 */
export async function assembleChatPrompt(params: {
  role: Role | null;
  fallbackRoleId: string;
  message: string;
  resolveEnabledSkill: SkillResolver;
  /** The current epoch's latest `thread_summaries` row body, or null when none exists yet. */
  summary: string | null;
  /** Verbatim history for the current epoch, strictly after `compacted_through_message_id`, oldest first. */
  history: readonly ContextMessage[];
  memoryFacts?: readonly MemoryFact[];
}): Promise<string> {
  const systemPrompt = await assembleSystemPrompt(params);
  const sections = [systemPrompt];
  if (params.summary !== null && params.summary.trim().length > 0) {
    sections.push(`## Earlier in this conversation\n\n${params.summary.trim()}`);
  }
  for (const message of params.history) {
    sections.push(`[${message.role}] ${message.body}`);
  }
  return sections.join("\n\n");
}

import type { Role, Skill } from "@oikonomos/db";

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
}): Promise<string> {
  const base = buildRoleSystemPrompt(params.role, params.fallbackRoleId);
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

import { withBudgetSink, type AgentProvider, type BudgetSink } from "@oikonomos/agent-providers";

/** Group rooms are deliberately bounded to prevent committee-chatter wakeups. */
export const GROUP_MEMBER_CAP = 6;

/** The inexpensive, non-agentic provider currently available for Tier-0 work. */
export const TIER_ZERO_PROVIDER_ID = "gemini";

export interface GroupMember {
  readonly roleId: string;
  readonly name: string;
  readonly title: string;
  readonly description: string;
}

export interface ScoreCandidate {
  readonly member: GroupMember;
  readonly message: string;
}

/** Injected so selection semantics remain testable without a model. */
export type ShouldRespondScorer = (candidate: ScoreCandidate) => Promise<number>;

export interface RouteGroupMessageRequest {
  readonly message: string;
  readonly members: readonly GroupMember[];
  readonly mostRecentResponderRoleId: string | null;
  readonly scorer: ShouldRespondScorer;
}

export interface GroupRoute {
  readonly recipients: readonly GroupMember[];
  readonly reason: "mentioned" | "everyone" | "scored";
}

/**
 * Determines which members receive a group message. The only side effect is
 * the injected scorer for an unaddressed message; mention handling and tie
 * breaking are deterministic.
 */
export async function route(request: RouteGroupMessageRequest): Promise<GroupRoute> {
  const message = request.message.trim();
  if (message.length === 0) throw new Error("group routing requires a non-empty message.");
  validateMembers(request.members);

  const mentions = mentionsIn(message);
  if (mentions.has("everyone")) return { recipients: request.members, reason: "everyone" };

  const mentioned = request.members.filter((member) => mentions.has(normalizeName(member.name)));
  if (mentioned.length > 0) return { recipients: mentioned, reason: "mentioned" };

  let bestScore = Number.NEGATIVE_INFINITY;
  let candidates: GroupMember[] = [];
  for (const member of request.members) {
    const score = await request.scorer({ member, message });
    if (!Number.isFinite(score)) {
      throw new Error(`group routing scorer returned a non-finite score for ${member.roleId}.`);
    }
    if (score > bestScore) {
      bestScore = score;
      candidates = [member];
    } else if (score === bestScore) {
      candidates.push(member);
    }
  }

  const recent = candidates.find((member) => member.roleId === request.mostRecentResponderRoleId);
  return { recipients: [recent ?? candidates[0]!], reason: "scored" };
}

export interface CreateTierZeroScorerOptions {
  /** The governed Tier-0 provider supplied by the composition layer. */
  readonly provider: AgentProvider;
  /** Every classifier turn is attributed before completion is observed. */
  readonly budgetSink: BudgetSink;
  /** Required by AgentProvider; supplied by the eventual runtime composition. */
  readonly cwd: string;
}

/**
 * Builds the default classifier scorer through agent-providers' budgeted
 * wrapper. TASK-189 owns selecting and composing its production adapter.
 */
export function createTierZeroScorer(options: CreateTierZeroScorerOptions): ShouldRespondScorer {
  if (options.provider.id !== TIER_ZERO_PROVIDER_ID) {
    throw new Error(`group routing Tier-0 scorer requires ${TIER_ZERO_PROVIDER_ID}, received ${options.provider.id}.`);
  }
  const provider = withBudgetSink(options.provider, options.budgetSink);

  return async ({ member, message }): Promise<number> => {
    const text: string[] = [];
    let completed = false;
    for await (const event of provider.sendPrompt({
      prompt: scorerPrompt(member, message),
      cwd: options.cwd,
      sessionId: null,
      model: null,
      signal: new AbortController().signal,
    })) {
      if (event.type === "text_delta") text.push(event.text);
      if (event.type === "error" && event.fatal) throw new Error(`Tier-0 scorer failed: ${event.message}`);
      if (event.type === "turn_complete") completed = true;
    }
    // A score from an incomplete provider stream would evade withBudgetSink's
    // accounting hook, so fail closed instead of routing on it.
    if (!completed) throw new Error("Tier-0 scorer ended before a budgeted turn completed.");
    return parseScore(text.join(""));
  };
}

function validateMembers(members: readonly GroupMember[]): void {
  if (members.length === 0) throw new Error("group routing requires at least one member.");
  if (members.length > GROUP_MEMBER_CAP) {
    throw new Error(`group routing supports at most ${GROUP_MEMBER_CAP} members; received ${members.length}.`);
  }
  const roleIds = new Set<string>();
  const names = new Set<string>();
  for (const member of members) {
    if (member.roleId.trim().length === 0 || normalizeName(member.name).length === 0) {
      throw new Error("group routing members require non-empty roleId and name.");
    }
    if (roleIds.has(member.roleId) || names.has(normalizeName(member.name))) {
      throw new Error("group routing members must have unique roleIds and names.");
    }
    roleIds.add(member.roleId);
    names.add(normalizeName(member.name));
  }
}

function mentionsIn(message: string): Set<string> {
  return new Set([...message.matchAll(/@([\p{L}\p{N}_-]+)/gu)].map((match) => normalizeName(match[1]!)));
}

function normalizeName(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase();
}

function scorerPrompt(member: GroupMember, message: string): string {
  return [
    "Return only a JSON object with a numeric score from 0 through 1.",
    "Score how appropriate it is for this group member to respond to the message.",
    `Member title: ${member.title}`,
    `Member description: ${member.description}`,
    `Message: ${message}`,
  ].join("\n");
}

function parseScore(response: string): number {
  try {
    const parsed: unknown = JSON.parse(response);
    if (typeof parsed === "object" && parsed !== null && "score" in parsed) {
      const score = (parsed as { score: unknown }).score;
      if (typeof score === "number" && score >= 0 && score <= 1) return score;
    }
  } catch {
    // Fall through to a clear error below; accepting arbitrary prose makes routing non-deterministic.
  }
  throw new Error("Tier-0 scorer must return JSON {\"score\": number between 0 and 1}.");
}

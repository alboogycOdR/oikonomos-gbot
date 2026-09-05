import type { Role } from "@oikonomos/db";

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

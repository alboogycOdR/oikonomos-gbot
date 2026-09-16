import { getRole, getRoleByName, type DatabaseOptions } from "@oikonomos/db";

/**
 * A model addressing `send_to_role` (or any tool taking a role identifier)
 * knows another bot only by the human-facing name it appears under in
 * conversation — its real `role_id` UUID is never surfaced to a bot at all,
 * on either provider lane. Without this resolution step every cross-bot
 * handoff attempt fails with an unresolvable ID the caller had no way to
 * obtain (confirmed live, 2026-09-16: a real Gemini run called
 * `send_to_role` with `toRoleId: "jipolt"` verbatim and the handoff never
 * reached anyone).
 *
 * Deliberately NOT inside `sendToRole` itself (`services/workspace`): that
 * module is documented as accepting nothing beyond identity/text/refs, and
 * its existing unit tests inject a fake `send` only, asserting the mailbox's
 * shape contract without a database — adding a mandatory DB lookup inside it
 * broke all of them (`getaddrinfo ENOTFOUND` against the test fixture's fake
 * connection string). Resolution belongs at the tool-call boundary, where
 * the real database is already in scope, not inside the pure mailbox write.
 *
 * Takes the SENDER's own `role_id` rather than a tenant string, and resolves
 * its real `tenant_id` from that row before searching by name — confirmed
 * live, 2026-09-16, that `request.task.tenantId` (the hardcoded `"basileia"`
 * literal every task/run row is stamped with) does NOT match a real role's
 * own `tenant_id` column (a genuine per-user value, e.g. a Firebase UID).
 * Scoping the name search by the task's tenant literal silently matched
 * nothing for every real bot in this deployment. The sender's own row is
 * the one tenant value guaranteed to be correct for this lookup.
 *
 * Tries the value as a real ID first so an already-correct UUID never pays
 * for a lookup or risks a name collision.
 */
export async function resolveRoleIdentifier(options: DatabaseOptions, fromRoleId: string, idOrName: string): Promise<string> {
  const byId = await getRole(options, idOrName);
  if (byId !== null) return byId.roleId;
  const sender = await getRole(options, fromRoleId);
  if (sender === null) throw new Error(`Sending role ${fromRoleId} was not found.`);
  const byName = await getRoleByName(options, sender.tenantId, idOrName);
  if (byName !== null) return byName.roleId;
  throw new Error(`No role found with ID or name "${idOrName}".`);
}

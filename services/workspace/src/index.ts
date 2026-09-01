/**
 * TASK-090 / Addendum F §4.1 (F9), §2.2 (F2), §3.5 (F8) — the single place
 * that understands the Office filesystem: path resolution, durability-tier
 * classification, and the role-to-role handoff mailbox.
 */
export {
  assertContained,
  classifyTier,
  resolveWorkspacePath,
  ROLES_ROOT,
  SealedSecretPathError,
  SEALED_SECRETS_ROOT,
  WORKSPACE_ROOT,
  WorkspacePathError,
  type DurabilityTier,
  type ResolveOptions,
  type ResolvedWorkspacePath,
} from "./paths.js";

export {
  sendToRole,
  type SendToRoleAcknowledgement,
  type SendToRoleDeps,
  type SendToRoleInput,
} from "./mailbox.js";

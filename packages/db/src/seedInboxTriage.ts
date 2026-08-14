import { fileURLToPath } from "node:url";

import { Database } from "./database.js";
import type { Capability, RoleGrant } from "./types.js";

export const inboxTriageCapabilities: readonly Capability[] = [
  {
    capabilityId: "email.list",
    description: "List Gmail messages.",
    defaultTier: "T0_observe",
    adapter: "mcp:gmail",
    enabled: true,
  },
  {
    capabilityId: "email.create_draft",
    description: "Create a Gmail draft.",
    defaultTier: "T1_draft",
    adapter: "mcp:gmail",
    enabled: true,
  },
  {
    capabilityId: "email.send",
    description: "Send a Gmail message.",
    defaultTier: "T3_external",
    adapter: "mcp:gmail",
    enabled: false,
  },
];

export const inboxTriageRoleGrants: readonly RoleGrant[] = inboxTriageCapabilities.map(
  (capability) => ({
    roleId: "inbox-triage",
    capabilityId: capability.capabilityId,
    maxTier: "T1_draft",
    constraints: { rate_per_hour: 40, domains: ["*"] },
  }),
);

/** Idempotently applies the Gmail manifest's inbox-triage capabilities and grants. */
export async function seedInboxTriage(database: Database): Promise<void> {
  for (const capability of inboxTriageCapabilities) {
    await database.upsertCapability(capability);
  }
  for (const roleGrant of inboxTriageRoleGrants) {
    await database.upsertRoleGrant(roleGrant);
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString.trim().length === 0) {
    throw new Error("DATABASE_URL is required to run the inbox-triage seed.");
  }

  const database = new Database({ connectionString });
  try {
    await seedInboxTriage(database);
  } finally {
    await database.close();
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

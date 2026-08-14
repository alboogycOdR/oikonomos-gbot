import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  Database,
  defaultPoolConfig,
  seedInboxTriage,
} from "../src/index.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("inbox-triage seed", () => {
  let database: Database;

  beforeAll(() => {
    database = new Database({ connectionString: connectionString! });
  });

  afterAll(async () => {
    await database.close();
  });

  it("uses conservative PgBouncer-compatible connection limits", () => {
    expect(defaultPoolConfig).toEqual({
      max: 10,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
      maxUses: 7_500,
    });
  });

  it("is idempotent and matches the Gmail manifest tiers", async () => {
    const capabilityIds = ["email.create_draft", "email.list", "email.send"];

    await seedInboxTriage(database);
    const firstCapabilities = await Promise.all(
      capabilityIds.map((capabilityId) => database.getCapability(capabilityId)),
    );
    const firstGrants = await Promise.all(
      capabilityIds.map((capabilityId) => database.getRoleGrant("inbox-triage", capabilityId)),
    );

    await seedInboxTriage(database);
    const secondCapabilities = await Promise.all(
      capabilityIds.map((capabilityId) => database.getCapability(capabilityId)),
    );
    const secondGrants = await Promise.all(
      capabilityIds.map((capabilityId) => database.getRoleGrant("inbox-triage", capabilityId)),
    );

    expect(secondCapabilities).toEqual(firstCapabilities);
    expect(secondGrants).toEqual(firstGrants);
    expect(firstCapabilities).toEqual([
      {
        capabilityId: "email.create_draft",
        description: "Create a Gmail draft.",
        defaultTier: "T1_draft",
        adapter: "mcp:gmail",
        enabled: true,
      },
      {
        capabilityId: "email.list",
        description: "List Gmail messages.",
        defaultTier: "T0_observe",
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
    ]);
    expect(firstGrants).toEqual([
      {
        roleId: "inbox-triage",
        capabilityId: "email.create_draft",
        maxTier: "T1_draft",
        constraints: { rate_per_hour: 40, domains: ["*"] },
      },
      {
        roleId: "inbox-triage",
        capabilityId: "email.list",
        maxTier: "T1_draft",
        constraints: { rate_per_hour: 40, domains: ["*"] },
      },
      {
        roleId: "inbox-triage",
        capabilityId: "email.send",
        maxTier: "T1_draft",
        constraints: { rate_per_hour: 40, domains: ["*"] },
      },
    ]);
  });
});

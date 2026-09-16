import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";
import { Database, type DatabaseOptions, type RiskTier } from "@oikonomos/db";

import { buildApp } from "./app.js";
import { createDatabaseBackedDeps } from "./ports.js";
import { DEFAULT_ROLE_CAPABILITIES } from "./defaultCapabilities.js";

/**
 * TASK-264 — ADR-018 Amendment 2026-09-16: `POST /roles` now auto-grants
 * the named `DEFAULT_ROLE_CAPABILITIES` set instead of filtering on
 * `capability.adapter === "sdk:builtin"`.
 *
 * TASK-035/044 precedent: a skipping DB test is not evidence. This suite
 * runs for real whenever DATABASE_URL is set (as ORCH does at review, via
 * `scripts/test-isolated.ps1`) and is skipped — visibly, via
 * `describe.skip` — otherwise.
 */
const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;
const TEST_TOKEN = "task-264-fixture-shared-secret";
const AUTH_HEADERS = { authorization: `Bearer ${TEST_TOKEN}` };

/**
 * Capability ids that must NEVER end up in a freshly-created role's grants,
 * even though several of them (workspace.request_secret, gmail.*) are
 * genuinely registered capabilities elsewhere in the system. Deliberately
 * includes one representative from each excluded family named by the
 * amendment: the credential-handoff capability and one capability per
 * account-linked connector (Gmail, Calendar, Drive).
 */
const EXCLUDED_CAPABILITY_IDS = [
  "workspace.request_secret",
  "gmail.send_message",
  "google-calendar.create_event",
  "google-drive.create_file",
] as const;

integration("control-api — POST /roles auto-grant floor (real Postgres, TASK-264)", () => {
  const options: DatabaseOptions = { connectionString: connectionString ?? "" };

  async function seedAllKnownCapabilities(): Promise<void> {
    const database = new Database(options);
    try {
      // The ten members of the new default floor, each at a distinct
      // manifest-plausible default tier so the test can prove tier
      // resolution is read live per-capability, not hardcoded.
      const seeds: Array<{ capabilityId: string; defaultTier: RiskTier; adapter: string }> = [
        { capabilityId: "fs.read", defaultTier: "T0_observe", adapter: "sdk:builtin" },
        { capabilityId: "fs.write", defaultTier: "T2_internal", adapter: "sdk:builtin" },
        { capabilityId: "runtime.bash", defaultTier: "T3_external", adapter: "sdk:builtin" },
        { capabilityId: "browser.session", defaultTier: "T1_draft", adapter: "mcp:steel-browser" },
        { capabilityId: "browser.navigate", defaultTier: "T1_draft", adapter: "mcp:steel-browser" },
        { capabilityId: "browser.read", defaultTier: "T0_observe", adapter: "mcp:steel-browser" },
        { capabilityId: "browser.interact", defaultTier: "T2_internal", adapter: "mcp:steel-browser" },
        { capabilityId: "browser.screenshot", defaultTier: "T0_observe", adapter: "mcp:steel-browser" },
        { capabilityId: "workspace.rename_self", defaultTier: "T1_draft", adapter: "mcp:workspace" },
        { capabilityId: "workspace.send_to_role", defaultTier: "T1_draft", adapter: "mcp:workspace" },
        { capabilityId: "workspace.create_routine", defaultTier: "T1_draft", adapter: "mcp:workspace" },
        // Explicitly-excluded capabilities, seeded too, so the test proves
        // exclusion is a deliberate filter and not an accident of these
        // rows simply not existing yet.
        { capabilityId: "workspace.request_secret", defaultTier: "T3_external", adapter: "mcp:workspace" },
        { capabilityId: "gmail.send_message", defaultTier: "T2_internal", adapter: "mcp:gmail" },
        { capabilityId: "google-calendar.create_event", defaultTier: "T2_internal", adapter: "mcp:google-calendar" },
        { capabilityId: "google-drive.create_file", defaultTier: "T2_internal", adapter: "mcp:google-drive" },
      ];
      for (const seed of seeds) {
        await database.upsertCapability({
          capabilityId: seed.capabilityId,
          description: `TASK-264 fixture: ${seed.capabilityId}`,
          defaultTier: seed.defaultTier,
          adapter: seed.adapter,
          enabled: true,
        });
      }
    } finally {
      await database.close();
    }
  }

  it("grants a freshly-created role exactly the DEFAULT_ROLE_CAPABILITIES set, each at its live manifest-declared default tier", async () => {
    await seedAllKnownCapabilities();

    const app = buildApp(createDatabaseBackedDeps(options), { authToken: TEST_TOKEN, logger: false });
    try {
      const createRes = await app.inject({
        method: "POST",
        url: "/roles",
        headers: AUTH_HEADERS,
        payload: { name: `task-264-role-${randomUUID()}`, description: "TASK-264 fixture role" },
      });
      expect(createRes.statusCode).toBe(201);
      const role = JSON.parse(createRes.body) as { id: string };
      expect(role.id).toBeTruthy();

      const grantsRes = await app.inject({
        method: "GET",
        url: `/roles/${role.id}/grants`,
        headers: AUTH_HEADERS,
      });
      expect(grantsRes.statusCode).toBe(200);
      const grants = JSON.parse(grantsRes.body) as { capabilityId: string; maxTier: string }[];

      // AC1: exactly the ten DEFAULT_ROLE_CAPABILITIES ids, no more, no less.
      const grantedIds = grants.map((grant) => grant.capabilityId).sort();
      expect(grantedIds).toEqual([...DEFAULT_ROLE_CAPABILITIES].sort());
      expect(grants).toHaveLength(DEFAULT_ROLE_CAPABILITIES.length);

      // Each grant's maxTier matches that capability's live default_tier
      // (proves tier resolution reads the registry, not a hardcoded value).
      const grantsByCapability = new Map(grants.map((grant) => [grant.capabilityId, grant.maxTier]));
      expect(grantsByCapability.get("fs.read")).toBe("T0_observe");
      expect(grantsByCapability.get("fs.write")).toBe("T2_internal");
      expect(grantsByCapability.get("runtime.bash")).toBe("T3_external");
      expect(grantsByCapability.get("browser.interact")).toBe("T2_internal");
      expect(grantsByCapability.get("browser.screenshot")).toBe("T0_observe");
      expect(grantsByCapability.get("workspace.create_routine")).toBe("T1_draft");

      // AC2: workspace.request_secret and every Gmail/Calendar/Drive
      // capability id are absent — confirmed by the SAME grants read, even
      // though all four are genuinely registered capabilities (seeded
      // above), proving this is a deliberate exclusion, not a missing row.
      for (const excludedId of EXCLUDED_CAPABILITY_IDS) {
        expect(grantedIds).not.toContain(excludedId);
      }
    } finally {
      await app.close();
    }
  });
});

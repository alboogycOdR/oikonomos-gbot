import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";
import { Database, type DatabaseOptions } from "@oikonomos/db";

import { buildApp } from "./app.js";
import { createDatabaseBackedDeps } from "./ports.js";
import { DEFAULT_ROLE_CAPABILITIES, isDefaultRoleCapability } from "./defaultCapabilities.js";

/**
 * TASK-264 — ADR-018 Amendment 2026-09-16: `POST /roles` now auto-grants
 * the named `DEFAULT_ROLE_CAPABILITIES` set instead of filtering on
 * `capability.adapter === "sdk:builtin"`.
 *
 * TASK-035/044 precedent: a skipping DB test is not evidence. This suite
 * runs for real whenever DATABASE_URL is set (as ORCH does at review, via
 * `scripts/test-isolated.ps1`) and is skipped — visibly, via
 * `describe.skip` — otherwise.
 *
 * TASK-265's adversarial review (required change 2,
 * docs/decisions/ADR-018-review-amendment-cx9-2026-09.md) rejected this
 * test's original version because it manufactured non-manifest capability
 * ids (`gmail.send_message`, `google-calendar.create_event`,
 * `google-drive.create_file`) via `upsertCapability`, permanently polluting
 * the isolated registry with rows no manifest declares — a direct
 * contributor to TASK-266's `StaleCapabilityRowError` cascade. This version
 * seeds nothing: it reads whatever `scripts/test-isolated.ps1 -Init` already
 * registered for real, from the actual connector manifests and
 * `BUILTIN_TOOLS` (see `services/worker/src/registerCapabilities.ts`), and
 * asserts against those live rows only.
 */
const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;
const TEST_TOKEN = "task-264-fixture-shared-secret";
const AUTH_HEADERS = { authorization: `Bearer ${TEST_TOKEN}` };

// Real, manifest-registered adapters for the three account-linked connectors
// this task must never auto-grant. Not a fabricated id — just a filter over
// whatever the live registry actually contains under these adapter tags.
const EXCLUDED_CONNECTOR_ADAPTERS = ["mcp:gmail", "mcp:google-calendar", "mcp:google-drive"] as const;

integration("control-api — POST /roles auto-grant floor (real Postgres, TASK-264)", () => {
  const options: DatabaseOptions = { connectionString: connectionString ?? "" };

  it("grants a freshly-created role exactly the DEFAULT_ROLE_CAPABILITIES set, each at its live manifest-declared default tier", async () => {
    const database = new Database(options);
    let allCapabilities: Awaited<ReturnType<typeof database.listCapabilities>>;
    try {
      allCapabilities = await database.listCapabilities();
    } finally {
      await database.close();
    }

    // Precondition on the environment, not a seed of our own: this proves
    // `scripts/test-isolated.ps1 -Init` actually registered the rows this
    // test depends on, so a silently-empty registry fails loudly here
    // instead of producing a vacuously-true assertion below.
    const registeredDefaults = allCapabilities.filter((capability) => isDefaultRoleCapability(capability.capabilityId));
    expect(registeredDefaults.map((capability) => capability.capabilityId).sort()).toEqual(
      [...DEFAULT_ROLE_CAPABILITIES].sort(),
    );

    const excludedConnectorIds = allCapabilities
      .filter((capability) => (EXCLUDED_CONNECTOR_ADAPTERS as readonly string[]).includes(capability.adapter))
      .map((capability) => capability.capabilityId);
    // Guards against a silently-empty manifest registration making AC2 vacuous.
    expect(excludedConnectorIds.length).toBeGreaterThan(0);

    const requestSecretCapability = allCapabilities.find((capability) => capability.capabilityId === "workspace.request_secret");
    expect(requestSecretCapability).toBeDefined();

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

      // AC1: exactly the DEFAULT_ROLE_CAPABILITIES ids, no more, no less.
      const grantedIds = grants.map((grant) => grant.capabilityId).sort();
      expect(grantedIds).toEqual([...DEFAULT_ROLE_CAPABILITIES].sort());
      expect(grants).toHaveLength(DEFAULT_ROLE_CAPABILITIES.length);

      // Each grant's maxTier matches that capability's live default_tier
      // (proves tier resolution reads the registry, not a hardcoded value).
      const grantsByCapability = new Map(grants.map((grant) => [grant.capabilityId, grant.maxTier]));
      for (const capability of registeredDefaults) {
        expect(grantsByCapability.get(capability.capabilityId)).toBe(capability.defaultTier);
      }

      // AC2: workspace.request_secret and every Gmail/Calendar/Drive
      // capability id are absent — confirmed by the SAME grants read, even
      // though they are genuinely registered capabilities in the live
      // registry, proving this is a deliberate exclusion, not a missing row.
      expect(grantedIds).not.toContain("workspace.request_secret");
      for (const excludedId of excludedConnectorIds) {
        expect(grantedIds).not.toContain(excludedId);
      }
    } finally {
      await app.close();
    }
  });
});

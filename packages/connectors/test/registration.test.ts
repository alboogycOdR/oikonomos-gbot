import type { ConnectorRegistrationRows, ConnectorRegistrationStore } from "@oikonomos/db";
import { describe, expect, it } from "vitest";

import {
  deregisterConnector,
  InvalidConnectorManifestError,
  registerConnector,
} from "../src/index.js";
import { handoverGmailObject, yamlFrom } from "./helpers.js";

class MemoryRegistrationStore implements ConnectorRegistrationStore {
  public registerCalls = 0;
  readonly capabilities = new Map<string, ConnectorRegistrationRows["capabilities"][number]>();
  readonly grants = new Map<string, ConnectorRegistrationRows["roleGrants"][number]>();
  readonly owners = new Map<string, string>();

  public async register(rows: ConnectorRegistrationRows): Promise<void> {
    this.registerCalls += 1;
    for (const capability of rows.capabilities) {
      const owner = this.owners.get(capability.capabilityId);
      if (owner !== undefined && owner !== rows.connectorId) {
        throw new Error("cross-connector capability collision");
      }
      this.owners.set(capability.capabilityId, rows.connectorId);
      this.capabilities.set(capability.capabilityId, capability);
    }
    for (const grant of rows.roleGrants) {
      this.grants.set(`${grant.roleId}:${grant.capabilityId}`, grant);
    }
  }

  public async deregister(connectorId: string): Promise<void> {
    for (const [capabilityId, owner] of this.owners) {
      if (owner === connectorId) {
        this.owners.delete(capabilityId);
        this.capabilities.delete(capabilityId);
        for (const key of this.grants.keys()) {
          if (key.endsWith(`:${capabilityId}`)) {
            this.grants.delete(key);
          }
        }
      }
    }
  }

  public snapshot(): string {
    return JSON.stringify({
      capabilities: [...this.capabilities.entries()].sort(([a], [b]) => a.localeCompare(b)),
      grants: [...this.grants.entries()].sort(([a], [b]) => a.localeCompare(b)),
      owners: [...this.owners.entries()].sort(([a], [b]) => a.localeCompare(b)),
    });
  }
}

function manifestFor(connectorId: string): string {
  const manifest = handoverGmailObject();
  manifest.connector_id = connectorId;
  manifest.mcp_server = {
    name: connectorId,
    transport: "remote",
    url_ref: `secret://mcp/${connectorId}/url`,
  };
  const tools = manifest.tools as Array<Record<string, unknown>>;
  manifest.tools = tools.map((tool) => ({
    ...tool,
    capability_id: `${connectorId}.${String(tool.capability_id)}`,
  }));
  return yamlFrom(manifest);
}

describe("connector registration", () => {
  it("maps manifest tools and grants, preserving enabled: false", async () => {
    const store = new MemoryRegistrationStore();
    await registerConnector(manifestFor("gmail"), store);

    expect(store.capabilities.get("gmail.email.send")).toMatchObject({
      defaultTier: "T3_external",
      enabled: false,
    });
    expect(store.grants.get("inbox-triage:gmail.email.send")).toMatchObject({
      maxTier: "T1_draft",
      constraints: { rate_per_hour: 40, domains: ["*"] },
    });
  });

  it("is idempotent by full row snapshot, not merely row count", async () => {
    const store = new MemoryRegistrationStore();
    const manifest = manifestFor("gmail");
    await registerConnector(manifest, store);
    const first = store.snapshot();
    await registerConnector(manifest, store);

    expect(store.snapshot()).toBe(first);
  });

  it("deregisters only the requested connector and preserves the other's complete snapshot", async () => {
    const store = new MemoryRegistrationStore();
    await registerConnector(manifestFor("gmail"), store);
    await registerConnector(manifestFor("calendar"), store);
    const calendarBefore = JSON.stringify({
      capabilities: [...store.capabilities].filter(([id]) => id.startsWith("calendar.")).sort(),
      grants: [...store.grants].filter(([, grant]) => grant.capabilityId.startsWith("calendar.")).sort(),
    });

    await deregisterConnector("gmail", store);

    expect([...store.capabilities.keys()].some((id) => id.startsWith("gmail."))).toBe(false);
    expect(JSON.stringify({
      capabilities: [...store.capabilities].filter(([id]) => id.startsWith("calendar.")).sort(),
      grants: [...store.grants].filter(([, grant]) => grant.capabilityId.startsWith("calendar.")).sort(),
    })).toBe(calendarBefore);
  });

  it("refuses an invalid non-basileia manifest before the store is called (validator mutation target)", async () => {
    const store = new MemoryRegistrationStore();
    const invalid = handoverGmailObject();
    invalid.account_ownership = "client";

    await expect(registerConnector(yamlFrom(invalid), store)).rejects.toBeInstanceOf(
      InvalidConnectorManifestError,
    );
    expect(store.registerCalls).toBe(0);
    expect(store.snapshot()).toBe('{"capabilities":[],"grants":[],"owners":[]}');
  });
});

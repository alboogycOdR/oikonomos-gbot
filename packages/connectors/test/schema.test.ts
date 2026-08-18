import { riskTiers as dbRiskTiers } from "@oikonomos/db";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { connectorManifestSchema, riskTiers } from "../src/index.js";
import { handoverGmailObject, handoverGmailYaml, yamlFrom } from "./helpers.js";
import { validateManifest } from "../src/index.js";

describe("Handover §4.4 gmail example (verbatim fixture)", () => {
  it("accepts the gmail YAML byte-for-byte from the handover example", () => {
    const result = validateManifest(handoverGmailYaml());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.manifest.connector_id).toBe("gmail");
    expect(result.manifest.account_ownership).toBe("basileia");
    expect(result.manifest.mcp_server.url_ref).toBe("secret://mcp/gmail/url");
    expect(result.manifest.oauth_scopes).toEqual(["gmail.readonly", "gmail.compose"]);
    expect(result.manifest.tools).toHaveLength(3);
    expect(result.manifest.tools[2]).toEqual({
      tool_name: "mcp__gmail__send_message",
      capability_id: "email.send",
      default_tier: "T3_external",
      enabled: false,
    });
    expect(result.manifest.role_grants[0]?.constraints).toEqual({
      rate_per_hour: 40,
      domains: ["*"],
    });
    expect(result.manifest.evals).toEqual({
      suite: "evals/golden/gmail",
      min_pass_rate: 0.9,
    });
  });

  it("also accepts the ADR-008 suite path under evals/golden/suites/", () => {
    const doc = handoverGmailObject();
    doc.evals = { suite: "evals/golden/suites/gmail", min_pass_rate: 0.9 };
    const result = validateManifest(yamlFrom(doc));
    expect(result.ok).toBe(true);
  });
});

describe("account_ownership (N5)", () => {
  it("rejects a missing account_ownership and names the field", () => {
    const doc = handoverGmailObject();
    delete doc.account_ownership;
    const result = validateManifest(yamlFrom(doc));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues.some((issue) => issue.field === "account_ownership")).toBe(true);
  });

  it("rejects a non-basileia account_ownership and names the field", () => {
    const doc = handoverGmailObject();
    doc.account_ownership = "client";
    const result = validateManifest(yamlFrom(doc));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues.some((issue) => issue.field === "account_ownership")).toBe(true);
  });
});

describe("tier enum and required tool fields", () => {
  it("rejects an unknown default_tier", () => {
    const doc = handoverGmailObject();
    const tools = doc.tools as Array<Record<string, unknown>>;
    tools[0] = { ...tools[0], default_tier: "T9_imaginary" };
    const result = validateManifest(yamlFrom(doc));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(
      result.issues.some((issue) => issue.field.includes("default_tier")),
    ).toBe(true);
  });

  it("rejects a tool without capability_id and names the field", () => {
    const doc = handoverGmailObject();
    const tools = doc.tools as Array<Record<string, unknown>>;
    const { capability_id: _dropped, ...without } = tools[0] ?? {};
    tools[0] = without;
    const result = validateManifest(yamlFrom(doc));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(
      result.issues.some((issue) => issue.field.includes("capability_id")),
    ).toBe(true);
  });

  it("rejects min_pass_rate below 0.9", () => {
    const doc = handoverGmailObject();
    doc.evals = { suite: "evals/golden/gmail", min_pass_rate: 0.89 };
    const result = validateManifest(yamlFrom(doc));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(
      result.issues.some((issue) => issue.field.includes("min_pass_rate")),
    ).toBe(true);
  });
});

describe("mcp_server.url_ref (N4)", () => {
  it("rejects a literal https URL", () => {
    const doc = handoverGmailObject();
    const literal = ["https://", "mcp.example.test", "/gmail"].join("");
    doc.mcp_server = { name: "gmail", transport: "remote", url_ref: literal };
    const result = validateManifest(yamlFrom(doc));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues.some((issue) => issue.field === "mcp_server.url_ref")).toBe(
      true,
    );
  });

  it("rejects a credential-looking literal (userinfo assembled from pieces)", () => {
    const doc = handoverGmailObject();
    const userinfo = ["https://", "alice", ":", "s3cret", "@", "mcp.example.test"].join(
      "",
    );
    doc.mcp_server = { name: "gmail", transport: "remote", url_ref: userinfo };
    const result = validateManifest(yamlFrom(doc));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    const issue = result.issues.find((item) => item.field === "mcp_server.url_ref");
    expect(issue?.message).toMatch(/credential-looking/i);
  });
});

describe("single tier vocabulary", () => {
  it("re-exports @oikonomos/db riskTiers by identity", () => {
    expect(riskTiers).toBe(dbRiskTiers);
    expect([...riskTiers]).toEqual([
      "T0_observe",
      "T1_draft",
      "T2_internal",
      "T3_external",
      "T4_irreversible",
    ]);
  });

  it("uses that same tuple as the zod enum values", () => {
    const parsed = connectorManifestSchema.shape.tools.element.shape.default_tier;
    expect(parsed.options).toEqual([...dbRiskTiers]);
  });
});

describe("account_ownership literal (mutation target)", () => {
  it("is a ZodLiteral of basileia — relaxing it to z.string() turns this red", () => {
    const field = connectorManifestSchema.shape.account_ownership;
    expect(field).toBeInstanceOf(z.ZodLiteral);
    expect(field.value).toBe("basileia");
    expect(field.safeParse("basileia").success).toBe(true);
    expect(field.safeParse("client").success).toBe(false);
    expect(field.safeParse("anything-else").success).toBe(false);
  });
});

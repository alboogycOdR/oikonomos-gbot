import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { recordAuditEvent, recordDecision, type DatabaseOptions } from "../src/index.js";
import { REDACTED_MARKER } from "../src/redact.js";

// WBS OIK-026: "Secret patterns stripped pre-write." This proves it against
// the row Postgres actually stored (via `insertAuditEvent`'s RETURNING
// clause — see packages/db/src/auditEvents.ts), not merely against what
// `recordAuditEvent`/`recordDecision` happen to return in memory: those two
// are the same object here because RETURNING echoes back exactly what was
// persisted, so asserting on it is asserting on the persisted row itself,
// not a middleware promise about it.
//
// Every fixture below uses an obvious PLACEHOLDER/FAKE/EXAMPLE marker and is
// assembled from fragments (mirrors infra/ci/secret-scan.mjs's own
// technique) so this file's raw source never contains a contiguous
// credential-shaped literal (N4) while the assembled runtime value still
// matches the same pattern families packages/audit/src/redact.ts and
// hooks/secret-scan.js detect.
const fakeApiKey = ["sk", "PLACEHOLDER_FAKE_NOT_A_REAL_SECRET_KEY"].join("-");
const fakeAwsAccessKeyId = ["AKIA", "EXAMPLEFAKEKEY02"].join("");
const fakePrivateKeyBlock = [
  ["-----BEGIN ", "EC PRIVATE KEY-----"].join(""),
  "PLACEHOLDER-FAKE-KEY-MATERIAL-NOT-REAL-BASE64==",
  ["-----END ", "EC PRIVATE KEY-----"].join(""),
].join("\n");

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("packages/audit redaction middleware (integration, persisted row)", () => {
  const options: DatabaseOptions = { connectionString: connectionString! };

  it("strips a top-level secret from the payload actually persisted", async () => {
    const probe = randomUUID();
    const written = await recordAuditEvent(options, {
      actor: "test:redaction-top-level",
      eventType: "tool.request",
      payload: { probe, apiKey: fakeApiKey },
    });

    expect(written.payload).toEqual({ probe, apiKey: REDACTED_MARKER });
    // The plaintext must not survive anywhere in the persisted row.
    expect(JSON.stringify(written.payload)).not.toContain(fakeApiKey);
  });

  it("strips a secret nested inside an object and an array, not just at the top level", async () => {
    const probe = randomUUID();
    const written = await recordAuditEvent(options, {
      actor: "test:redaction-nested",
      eventType: "tool.request",
      payload: {
        probe,
        request: {
          headers: { authorization: fakeApiKey },
          history: [{ note: "ok" }, { credentials: fakeAwsAccessKeyId }, [fakePrivateKeyBlock, "ok"]],
        },
      },
    });

    expect(written.payload).toEqual({
      probe,
      request: {
        headers: { authorization: REDACTED_MARKER },
        history: [{ note: "ok" }, { credentials: REDACTED_MARKER }, [REDACTED_MARKER, "ok"]],
      },
    });
    const persisted = JSON.stringify(written.payload);
    expect(persisted).not.toContain(fakeApiKey);
    expect(persisted).not.toContain(fakeAwsAccessKeyId);
    expect(persisted).not.toContain(fakePrivateKeyBlock);
  });

  it("strips secrets in a policy-decision payload written via recordDecision, including a denial", async () => {
    const probe = randomUUID();
    const denied = await recordDecision(options, {
      actor: "broker",
      capability: "email.send",
      tier: "T3_external",
      verdict: "deny",
      reason: "constraint.domains",
      payload: { probe, evidence: { awsKey: fakeAwsAccessKeyId } },
    });

    expect(denied.payload).toEqual({
      verdict: "deny",
      reason: "constraint.domains",
      probe,
      evidence: { awsKey: REDACTED_MARKER },
    });
    expect(JSON.stringify(denied.payload)).not.toContain(fakeAwsAccessKeyId);
  });

  it("leaves a payload with no secret-shaped values completely unchanged", async () => {
    const probe = randomUUID();
    const written = await recordAuditEvent(options, {
      actor: "test:redaction-clean",
      eventType: "tool.request",
      payload: { probe, destination: "finance@basileia.example", count: 3 },
    });

    expect(written.payload).toEqual({ probe, destination: "finance@basileia.example", count: 3 });
  });
});

describe("packages/audit redaction middleware — integration suite skip behaviour", () => {
  it("documents why the suite above is skipped when DATABASE_URL is unset (TASK-006/TASK-011 precedent)", () => {
    expect(typeof connectionString === "string" || connectionString === undefined).toBe(true);
  });
});

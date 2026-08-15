import { describe, expect, it } from "vitest";

import * as auditApi from "../src/index.js";

describe("packages/audit persistence surface", () => {
  it("exposes no update, delete, or otherwise mutating operation on audit_events", () => {
    // audit_events is append-only end to end (WBS OIK-013): the database
    // enforces it with `audit_no_update` / `audit_no_delete` DO INSTEAD
    // NOTHING rules (infra/postgres/migrations/001_schema_v1.up.sql,
    // TASK-002), and this test proves the writer side never even offers a
    // path to attempt one. "UPDATE and DELETE ... are provable no-ops when
    // exercised through this package" holds structurally: there is no
    // exported function through which an UPDATE or DELETE could be
    // attempted in the first place.
    const mutatingNamePattern = /update|delete|mutate|patch|remove/i;
    const exportedNames = Object.keys(auditApi);

    for (const name of exportedNames) {
      expect(name).not.toMatch(mutatingNamePattern);
    }

    expect(exportedNames.sort()).toEqual(
      ["AuditWriteError", "recordAuditEvent", "recordDecision", "toDecisionAuditEvent"].sort(),
    );
  });

  it("does not re-export @oikonomos/db's raw insertAuditEvent as a bypass around AuditWriteError wrapping", () => {
    // Callers should only ever see failures as AuditWriteError, never the
    // raw underlying error — otherwise "audited vs not audited" detection
    // could silently fork into two different error shapes.
    expect(auditApi).not.toHaveProperty("insertAuditEvent");
  });
});

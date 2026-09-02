import { randomUUID } from "node:crypto";

import { createRole, getRoleMessage } from "@oikonomos/db";
import { beforeAll, describe, expect, it } from "vitest";

import { getFactById, resolve, writeMemoryFact } from "../../../packages/memory/src/index.js";
import { sendToRole } from "../../../services/workspace/src/index.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("OME two-role typed handoff — live ACL and version resolution (TASK-100)", () => {
  const suffix = randomUUID();
  const tenantId = `task-100-${suffix}`;
  const researcherRoleId = `task-100-researcher-${suffix}`;
  const drafterRoleId = `task-100-drafter-${suffix}`;
  const outsiderRoleId = `task-100-outsider-${suffix}`;
  const projectId = `task-100-project-${suffix}`;
  const key = "research.findings";
  const initialValue = "Initial research finding: use source A.";
  const correctedValue = "Corrected research finding: use source B.";

  beforeAll(async () => {
    await Promise.all([
      createRole({ connectionString: connectionString! }, {
        roleId: researcherRoleId,
        tenantId,
        name: "Researcher",
        title: "Researcher",
      }),
      createRole({ connectionString: connectionString! }, {
        roleId: drafterRoleId,
        tenantId,
        name: "Drafter",
        title: "Drafter",
      }),
      createRole({ connectionString: connectionString! }, {
        roleId: outsiderRoleId,
        tenantId,
        name: "Outsider",
        title: "Outsider",
      }),
    ]);
  });

  it("lets only the ACL recipient resolve a live, superseded fact reference without grants", async () => {
    const options = { connectionString: connectionString! };
    const initialFact = await writeMemoryFact(options, {
      tenantId,
      scope: "project",
      projectId,
      key,
      value: initialValue,
      source: "task-100-researcher",
      visibleTo: [drafterRoleId],
    });

    // Sending carries the locator only; it cannot grant the researcher access
    // to the fact it explicitly scoped to the drafter.
    expect(
      await resolve(options, { tenantId, roleId: researcherRoleId, projectId }, key),
    ).toBeNull();

    const handoffInput = {
      tenantId,
      fromRoleId: researcherRoleId,
      toRoleId: drafterRoleId,
      body: "Research complete; resolve the live finding.",
      handoffKind: "research.complete",
      factRef: { tenantId, scope: "project", projectId, key },
    } as const;
    const acknowledgement = await sendToRole(options, handoffInput);
    expect(acknowledgement.toRoleId).toBe(drafterRoleId);
    expect(acknowledgement.createdAt).toBeInstanceOf(Date);
    expect(handoffInput.factRef).toEqual({ tenantId, scope: "project", projectId, key });
    expect(JSON.stringify(handoffInput.factRef)).not.toContain(initialValue);

    // Read the live persisted message back rather than trusting the sender's
    // input object: the typed handoff stores only the locator, never a value.
    const persistedHandoff = await getRoleMessage(options, acknowledgement.messageId);
    expect(persistedHandoff).toMatchObject({
      fromRoleId: researcherRoleId,
      toRoleId: drafterRoleId,
      handoffKind: "research.complete",
      factRef: handoffInput.factRef,
    });
    expect(JSON.stringify(persistedHandoff?.factRef)).not.toContain(initialValue);

    const drafterBeforeCorrection = await resolve(
      options,
      { tenantId, roleId: drafterRoleId, projectId: handoffInput.factRef.projectId },
      handoffInput.factRef.key,
    );
    expect(drafterBeforeCorrection?.value).toBe(initialValue);

    // A recipient is allowed by the fact ACL, not by an implicit handoff grant.
    expect(
      await resolve(options, { tenantId, roleId: outsiderRoleId, projectId }, handoffInput.factRef.key),
    ).toBeNull();
    expect(
      await resolve(options, { tenantId, roleId: researcherRoleId, projectId }, handoffInput.factRef.key),
    ).toBeNull();

    const correctedFact = await writeMemoryFact(options, {
      tenantId,
      scope: "project",
      projectId,
      key,
      value: correctedValue,
      source: "task-100-researcher-correction",
      visibleTo: [drafterRoleId],
    });
    expect(correctedFact.factId).not.toBe(initialFact.factId);
    expect(initialFact.supersededBy).toBeNull();

    const supersededInitial = await getFactById(
      options,
      { tenantId, roleId: drafterRoleId },
      initialFact.factId,
    );
    expect(supersededInitial?.supersededBy).toBe(correctedFact.factId);

    // The stored reference is re-resolved after correction, so it sees the
    // current fact instead of the sender's value at handoff time.
    const drafterAfterCorrection = await resolve(
      options,
      { tenantId, roleId: drafterRoleId, projectId: handoffInput.factRef.projectId },
      handoffInput.factRef.key,
    );
    expect(drafterAfterCorrection?.value).toBe(correctedValue);
    expect(
      await resolve(options, { tenantId, roleId: outsiderRoleId, projectId }, handoffInput.factRef.key),
    ).toBeNull();
    expect(
      await resolve(options, { tenantId, roleId: researcherRoleId, projectId }, handoffInput.factRef.key),
    ).toBeNull();
  });
});

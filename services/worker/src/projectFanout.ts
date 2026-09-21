import { admitProjectFanout, type ProjectFanoutAdmission, type ProjectFanoutAdmissionInput } from "@oikonomos/db";

import type { ProjectToolIdentity } from "./projectTools.js";

export const PROJECT_FANOUT_CAP_MESSAGE = "Project fan-out cap reached for this manager turn.";

export function createProjectFanoutAdmission(identity: ProjectToolIdentity): (input: Omit<ProjectFanoutAdmissionInput, "tenantId" | "runId" | "actor" | "onAdmitted">, onAdmitted?: () => Promise<void>) => Promise<ProjectFanoutAdmission> {
  return (input, onAdmitted) => {
    if (identity.runId === undefined || identity.runId.trim() === "") {
      throw new Error("Project fan-out admission requires a run context.");
    }
    return admitProjectFanout(
      { connectionString: identity.connectionString },
      { ...input, tenantId: identity.tenantId, runId: identity.runId, actor: `agent:${identity.fromRoleId}`, onAdmitted },
    );
  };
}

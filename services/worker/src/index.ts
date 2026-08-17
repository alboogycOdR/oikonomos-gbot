export const workspaceName = "worker";

export function ping(): string {
  return workspaceName;
}

export {
  cancelTaskRun,
  failTaskRun,
  resumeInterruptedRun,
  startTaskRun,
} from "./runLifecycle.js";

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  describe("@oikonomos/worker", () => {
    it("ping returns the workspace name", () => {
      expect(ping()).toBe("worker");
    });
  });
}
export const workspaceName = "control-api";

export function ping(): string {
  return workspaceName;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  describe("@oikonomos/control-api", () => {
    it("ping returns the workspace name", () => {
      expect(ping()).toBe("control-api");
    });
  });
}
export const workspaceName = "audit";

export function ping(): string {
  return workspaceName;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  describe("@oikonomos/audit", () => {
    it("ping returns the workspace name", () => {
      expect(ping()).toBe("audit");
    });
  });
}
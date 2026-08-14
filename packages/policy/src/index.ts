export const workspaceName = "policy";

export function ping(): string {
  return workspaceName;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  describe("@oikonomos/policy", () => {
    it("ping returns the workspace name", () => {
      expect(ping()).toBe("policy");
    });
  });
}
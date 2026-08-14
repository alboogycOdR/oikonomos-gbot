export const workspaceName = "approvals";

export function ping(): string {
  return workspaceName;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  describe("@oikonomos/approvals", () => {
    it("ping returns the workspace name", () => {
      expect(ping()).toBe("approvals");
    });
  });
}
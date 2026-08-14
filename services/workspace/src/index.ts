export const workspaceName = "workspace";

export function ping(): string {
  return workspaceName;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  describe("@oikonomos/workspace", () => {
    it("ping returns the workspace name", () => {
      expect(ping()).toBe("workspace");
    });
  });
}
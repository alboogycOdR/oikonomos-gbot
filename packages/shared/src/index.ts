export const workspaceName = "shared";

export function ping(): string {
  return workspaceName;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  describe("@oikonomos/shared", () => {
    it("ping returns the workspace name", () => {
      expect(ping()).toBe("shared");
    });
  });
}
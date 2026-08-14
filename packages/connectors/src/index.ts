export const workspaceName = "connectors";

export function ping(): string {
  return workspaceName;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  describe("@oikonomos/connectors", () => {
    it("ping returns the workspace name", () => {
      expect(ping()).toBe("connectors");
    });
  });
}
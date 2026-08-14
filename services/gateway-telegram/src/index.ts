export const workspaceName = "gateway-telegram";

export function ping(): string {
  return workspaceName;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  describe("@oikonomos/gateway-telegram", () => {
    it("ping returns the workspace name", () => {
      expect(ping()).toBe("gateway-telegram");
    });
  });
}
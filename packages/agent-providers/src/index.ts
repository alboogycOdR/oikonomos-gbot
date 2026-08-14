export const workspaceName = "agent-providers";

export function ping(): string {
  return workspaceName;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  describe("@oikonomos/agent-providers", () => {
    it("ping returns the workspace name", () => {
      expect(ping()).toBe("agent-providers");
    });
  });
}
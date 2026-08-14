export const workspaceName = "shared";

export function ping(): string {
  return workspaceName;
}

export {
  canonicalJson,
  CanonicalJsonError,
  type CanonicalJsonErrorCode,
  type JsonValue,
} from "./canonicalJson.js";
export { actionDigest, type ActionDigestInput } from "./actionDigest.js";

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  describe("@oikonomos/shared", () => {
    it("ping returns the workspace name", () => {
      expect(ping()).toBe("shared");
    });
  });
}

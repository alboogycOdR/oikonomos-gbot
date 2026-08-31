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

export {
  SystemClock,
  DeadlinePolicy,
  DeadlineExceededError,
  RetryPolicy,
  RetryExhaustedError,
  PollingPolicy,
  PollingExhaustedError,
  IdleWatchdogPolicy,
  DebouncePolicy,
  type Clock,
  type TimerHandle,
  type DeadlinePolicyOptions,
  type RetryPolicyOptions,
  type PollingPolicyOptions,
  type IdleWatchdogPolicyOptions,
  type DebouncePolicyOptions,
} from "./scheduling/index.js";

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  describe("@oikonomos/shared", () => {
    it("ping returns the workspace name", () => {
      expect(ping()).toBe("shared");
    });
  });
}

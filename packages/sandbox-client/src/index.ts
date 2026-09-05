export const workspaceName = "sandbox-client";

export function ping(): string {
  return workspaceName;
}

export { createSandboxClient, type CreateSandboxClientOptions, type FetchLike, type SandboxClient } from "./client.js";
export { SandboxClientError, type SandboxClientErrorCode } from "./errors.js";
export {
  envKeyFromSecretRef,
  envSecretResolver,
  OPENSANDBOX_API_KEY_REF,
  OPENSANDBOX_EXECD_ACCESS_TOKEN_REF,
  type SecretResolver,
} from "./secretResolver.js";
export type {
  CreateSandboxRequest,
  CreateSandboxResponse,
  SandboxApiErrorBody,
  SandboxHealth,
  SandboxEndpoint,
  SandboxImageSpec,
  SandboxResourceLimits,
  SandboxState,
  SandboxStatus,
  RunCommandRequest,
  RunCommandResult,
} from "./types.js";

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  describe("@oikonomos/sandbox-client", () => {
    it("ping returns the workspace name", () => {
      expect(ping()).toBe("sandbox-client");
    });
  });
}

export const workspaceName = "worker";

export function ping(): string {
  return workspaceName;
}

export {
  cancelTaskRun,
  completeTaskRun,
  failTaskRun,
  resumeInterruptedRun,
  startTaskRun,
} from "./runLifecycle.js";

export {
  executeTaskRun,
  toScopedAllowedTool,
  WorkerExecutionError,
  type ConnectorContext,
  type ConnectorManifestSlice,
  type ConnectorMount,
  type ExecuteTaskRunInput,
  type ExecuteTaskRunResult,
} from "./executeRun.js";

export {
  CHAT_FANOUT_CAPABILITY_ID,
  createChatRunDriver,
  deliverBotToBotMessage,
  destinationFor,
  finalText,
  type BotToBotMessageRequest,
  type BotToBotMessageResult,
  type ChatRunDriver,
  type ChatRunRequest,
  type CreateChatRunDriverOptions,
} from "./chatRunDriver.js";

export {
  createGatedSubprocessProviders,
  type GatedCodexOptions,
  type GatedGrokOptions,
} from "./subprocessProviders.js";

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  describe("@oikonomos/worker", () => {
    it("ping returns the workspace name", () => {
      expect(ping()).toBe("worker");
    });
  });
}

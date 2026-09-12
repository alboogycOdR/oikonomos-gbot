export const workspaceName = "worker";

export function ping(): string {
  return workspaceName;
}

export {
  cancelTaskRun,
  completeTaskRun,
  failTaskRun,
  parkTaskRun,
  reconcileInterruptedRuns,
  resumeInterruptedRun,
  startTaskRun,
  type ReconcileOutcome,
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

export { createRunGate, type QueuedRun, type RunGate, type RunGateExecution, type RunGateOptions } from "./runConcurrency.js";

export {
  createTierZeroProvider,
  type CreateTierZeroProviderOptions,
  type TierZeroProvider,
} from "./tierZeroProvider.js";

export {
  GROUP_MEMBER_CAP,
  createTierZeroScorer,
  route,
  type CreateTierZeroScorerOptions,
  type GroupMember,
  type GroupRoute,
  type RouteGroupMessageRequest,
  type ScoreCandidate,
  type ShouldRespondScorer,
} from "./groupRouting.js";

export {
  createWorkerJobQueue,
  WorkerJobQueue,
  WORKER_HEARTBEAT_JOB,
  type CreateWorkerJobQueueOptions,
  type WorkerHeartbeatJob,
} from "./jobs/workerJobQueue.js";

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  describe("@oikonomos/worker", () => {
    it("ping returns the workspace name", () => {
      expect(ping()).toBe("worker");
    });
  });
}

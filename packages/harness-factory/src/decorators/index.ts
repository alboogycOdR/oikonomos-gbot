import { AsyncLocalStorage } from "node:async_hooks";

export interface ApprovalScope {
  readonly runId: string;
  readonly toolCallId: string;
  readonly approvalNonce?: string;
}

export interface ToolCallContext {
  readonly toolCallId?: string;
  readonly approvalNonce?: string;
}

export interface MountedTool<TInput = unknown, TResult = unknown> {
  readonly name: string;
  execute(input: TInput, context: ToolCallContext): Promise<TResult>;
}

export type ToolDecorator = <TInput, TResult>(tool: MountedTool<TInput, TResult>) => MountedTool<TInput, TResult>;

export class MissingToolCallIdError extends Error {
  readonly code = "MISSING_TOOL_CALL_ID";

  constructor(toolName: string) {
    super(`tool ${toolName} requires a toolCallId`);
    this.name = "MissingToolCallIdError";
  }
}

export class ToolTimeoutError extends Error {
  readonly code = "TOOL_TIMEOUT";

  constructor(toolName: string, timeoutMs: number) {
    super(`tool ${toolName} exceeded its ${timeoutMs}ms timeout`);
    this.name = "ToolTimeoutError";
  }
}

export interface TimerClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

const approvalScopeStorage = new AsyncLocalStorage<ApprovalScope>();

/** Returns the scope inherited by nested work within a decorated tool call. */
export function currentApprovalScope(): ApprovalScope | undefined {
  return approvalScopeStorage.getStore();
}

/**
 * Binds call identity for the dynamic extent of one tool invocation. `run()`
 * exits the AsyncLocalStorage context after the callback settles; the finally
 * additionally gives callers a deterministic retirement observation point.
 */
export function withApprovalScope(options: {
  readonly runId: string;
  readonly onRetire?: (scope: ApprovalScope) => void;
}): ToolDecorator {
  if (typeof options.runId !== "string" || options.runId.length === 0) {
    throw new Error("withApprovalScope requires a runId");
  }

  return (tool) => ({
    name: tool.name,
    async execute(input, context) {
      const toolCallId = context.toolCallId;
      if (typeof toolCallId !== "string" || toolCallId.length === 0) {
        throw new MissingToolCallIdError(tool.name);
      }
      const scope: ApprovalScope = {
        runId: options.runId,
        toolCallId,
        ...(context.approvalNonce === undefined ? {} : { approvalNonce: context.approvalNonce }),
      };
      try {
        return await approvalScopeStorage.run(scope, () => tool.execute(input, context));
      } finally {
        options.onRetire?.(scope);
      }
    },
  });
}

/** Makes absent call identity a typed, fail-closed error before tool work starts. */
export function withMandatoryCallId(): ToolDecorator {
  return (tool) => ({
    name: tool.name,
    async execute(input, context) {
      if (typeof context.toolCallId !== "string" || context.toolCallId.length === 0) {
        throw new MissingToolCallIdError(tool.name);
      }
      return tool.execute(input, context);
    },
  });
}

/** Races a tool invocation against its name-specific timeout and always clears the timer. */
export function withToolTimeout(options: {
  readonly timeoutMsForTool: (toolName: string) => number | undefined;
  readonly clock?: TimerClock;
}): ToolDecorator {
  const clock = options.clock ?? globalThis;
  return (tool) => ({
    name: tool.name,
    async execute(input, context) {
      const timeoutMs = options.timeoutMsForTool(tool.name);
      if (timeoutMs === undefined) {
        return tool.execute(input, context);
      }
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
        throw new Error(`tool ${tool.name} has an invalid timeout`);
      }

      let timer: unknown;
      const timeout = new Promise<never>((_, reject) => {
        timer = clock.setTimeout(() => reject(new ToolTimeoutError(tool.name, timeoutMs)), timeoutMs);
      });
      try {
        return await Promise.race([tool.execute(input, context), timeout]);
      } finally {
        clock.clearTimeout(timer);
      }
    },
  });
}

export function decorateTool<TInput, TResult>(
  tool: MountedTool<TInput, TResult>,
  decorators: readonly ToolDecorator[],
): MountedTool<TInput, TResult> {
  return decorators.reduceRight((wrapped, decorator) => decorator(wrapped), tool) as MountedTool<TInput, TResult>;
}

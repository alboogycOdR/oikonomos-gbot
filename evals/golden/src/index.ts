import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { composeHarness, type L1RunIdentity } from "@oikonomos/harness-factory/compose";
import type { AgentSdkQueryFn } from "@oikonomos/harness-factory";
import { parse } from "yaml";
import { z } from "zod";

/** Local mirror of the part of the connector manifest consumed by evals. */
export interface ConnectorEvalManifest {
  readonly connector_id: string;
  readonly evals: { readonly suite: string; readonly min_pass_rate: number };
}

export const draftOnlyTiers = ["T0_observe", "T1_draft", "T2_internal"] as const;
export type DraftOnlyTier = (typeof draftOnlyTiers)[number];

const taskSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  expected_outcome: z.object({ contains: z.array(z.string().min(1)).min(1) }).strict(),
  allowed_tiers: z.array(z.enum(draftOnlyTiers)).min(1),
}).strict();

const suiteSchema = z.object({
  connector_id: z.string().min(1),
  tasks: z.array(taskSchema),
}).strict();

export type GoldenTask = z.infer<typeof taskSchema>;
export type GoldenSuite = z.infer<typeof suiteSchema>;

export class GoldenEvalError extends Error {
  readonly code: "INVALID_SUITE" | "UNOBSERVABLE" | "CONFIGURATION";

  constructor(code: "INVALID_SUITE" | "UNOBSERVABLE" | "CONFIGURATION", message: string) {
    super(message);
    this.code = code;
  }
}

export interface TaskResult {
  readonly id: string;
  readonly pass: boolean;
  readonly assertions: readonly { readonly contains: string; readonly pass: boolean }[];
  readonly output: string;
}

export interface SuiteReport {
  readonly connector_id: string;
  readonly tasks: readonly TaskResult[];
  readonly pass_rate: number;
  readonly min_pass_rate: number;
  readonly passed: boolean;
  readonly harness_invocations: number;
}

export interface RunSuiteOptions {
  readonly manifest: ConnectorEvalManifest;
  readonly queryFn: AgentSdkQueryFn;
  readonly suitesRoot?: string;
}

/** Parses a suite object and rejects an empty suite as unobservable. */
export function validateSuite(raw: unknown, connectorId?: string): GoldenSuite {
  const parsed = suiteSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GoldenEvalError("INVALID_SUITE", parsed.error.issues.map((issue) => issue.path.join(".") || issue.message).join(", "));
  }
  if (connectorId !== undefined && parsed.data.connector_id !== connectorId) {
    throw new GoldenEvalError("INVALID_SUITE", `suite connector_id ${parsed.data.connector_id} does not match ${connectorId}`);
  }
  if (parsed.data.tasks.length === 0) {
    throw new GoldenEvalError("UNOBSERVABLE", "golden suite has zero tasks and is unobservable");
  }
  return parsed.data;
}

/**
 * Executes a connector suite through the sole sanctioned harness constructor.
 * queryFn is injected so CI never needs provider credentials or a live endpoint.
 */
export async function runSuite(connectorId: string, options: RunSuiteOptions): Promise<SuiteReport> {
  if (options.manifest.connector_id !== connectorId) {
    throw new GoldenEvalError("CONFIGURATION", "manifest connector_id does not match requested suite");
  }
  if (options.manifest.evals.min_pass_rate < 0.9 || options.manifest.evals.min_pass_rate > 1) {
    throw new GoldenEvalError("CONFIGURATION", "manifest evals.min_pass_rate must be between 0.9 and 1");
  }

  const suite = await loadSuite(connectorId, options.suitesRoot);
  let harnessInvocations = 0;
  const results: TaskResult[] = [];
  for (const task of suite.tasks) {
    const runtime = composeHarness({
      run: runIdentity(connectorId, task.id),
      allowedTools: ["Read(evals/golden/**)"],
      auditSink: { async writeCompletionEvidence() {} },
      pretooluse: {
        handlePreToolUse: async () => ({ decision: "allow", tier: "T0_observe", auditEventId: "golden-eval" }),
        dependencies: undefined,
      },
      queryFn: async function* (input) {
        harnessInvocations += 1;
        yield* options.queryFn(input);
      },
    });
    const output = await collectOutput(runtime.harness.query({ prompt: task.prompt }));
    const assertions = task.expected_outcome.contains.map((contains) => ({ contains, pass: output.includes(contains) }));
    results.push({ id: task.id, pass: assertions.every((assertion) => assertion.pass), assertions, output });
  }

  if (harnessInvocations === 0) {
    throw new GoldenEvalError("UNOBSERVABLE", "harness seam was not invoked");
  }
  const passRate = results.filter((result) => result.pass).length / results.length;
  return {
    connector_id: connectorId,
    tasks: results,
    pass_rate: passRate,
    min_pass_rate: options.manifest.evals.min_pass_rate,
    passed: passRate >= options.manifest.evals.min_pass_rate,
    harness_invocations: harnessInvocations,
  };
}

export async function loadSuite(connectorId: string, suitesRoot = defaultSuitesRoot()): Promise<GoldenSuite> {
  const directory = resolve(suitesRoot, connectorId);
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    throw new GoldenEvalError("UNOBSERVABLE", `golden suite directory is unavailable: ${directory}`);
  }
  const definitions = files.filter((file) => /\.(?:ya?ml|json)$/i.test(file));
  if (definitions.length === 0) {
    throw new GoldenEvalError("UNOBSERVABLE", `golden suite directory has zero task definitions: ${directory}`);
  }
  const raw = await readDefinition(join(directory, definitions[0]!));
  return validateSuite(raw, connectorId);
}

function defaultSuitesRoot(): string {
  return fileURLToPath(new URL("../suites/", import.meta.url));
}

async function readDefinition(path: string): Promise<unknown> {
  const text = await readFile(path, "utf8");
  try {
    return path.endsWith(".json") ? JSON.parse(text) : parse(text);
  } catch (error) {
    throw new GoldenEvalError("INVALID_SUITE", `could not parse ${path}`);
  }
}

function runIdentity(connectorId: string, taskId: string): L1RunIdentity {
  return { runId: `golden:${connectorId}:${taskId}`, roleId: "connector-eval", tenantId: "basileia", agentRef: { provider: "golden-eval", sessionRef: taskId, isSubagent: false } };
}

async function collectOutput(events: AsyncIterable<unknown>): Promise<string> {
  const parts: string[] = [];
  for await (const event of events) parts.push(stringifyEvent(event));
  return parts.join("\n");
}

function stringifyEvent(event: unknown): string {
  if (typeof event === "string") return event;
  if (typeof event === "object" && event !== null && "text" in event && typeof event.text === "string") return event.text;
  return JSON.stringify(event);
}

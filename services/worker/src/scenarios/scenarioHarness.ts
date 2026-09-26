import type { DatabaseOptions } from "@oikonomos/db";
import type { SandboxClient, SandboxEndpoint } from "@oikonomos/sandbox-client";

export const fixtureEndpoint: SandboxEndpoint = { endpoint: "http://sandbox.fixture.invalid/366" };
export const fixtureWorkspace = "/workspace/task-366-browser";

export interface FixtureCommandResult {
  readonly stdout: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

/**
 * In-process Steel fixture at the sandbox boundary. The production executor
 * reaches Steel with curl/CDP through this client, so queueing those replies
 * proves the actual command boundary without starting Steel or making a
 * network connection.
 */
export class FixtureSteelServer {
  readonly calls: string[] = [];
  private readonly replies: FixtureCommandResult[];

  constructor(replies: readonly FixtureCommandResult[]) {
    this.replies = [...replies];
  }

  client(): SandboxClient {
    return {
      runCommand: async (...[_endpoint, request]: Parameters<SandboxClient["runCommand"]>) => {
        this.calls.push(request.command);
        const reply = this.replies.shift();
        if (reply === undefined) throw new Error("fixture Steel server received an unexpected command");
        return { stdout: reply.stdout, stderr: reply.stderr ?? "", exitCode: reply.exitCode ?? 0 };
      },
    } as unknown as SandboxClient;
  }

  assertDrained(): void {
    if (this.replies.length !== 0) throw new Error(`fixture Steel server has ${this.replies.length} unconsumed replies`);
  }
}

export function steelRest(body: unknown, status = 200): FixtureCommandResult {
  return { stdout: `${JSON.stringify(body)}\n${status}` };
}

export function cdpResult(results: readonly Record<string, unknown>[]): FixtureCommandResult {
  return { stdout: JSON.stringify({ results }) };
}

export function evaluated(value: unknown): Record<string, unknown> {
  return { method: "Runtime.evaluate", result: { result: { value } } };
}

export function scenarioDatabase(): DatabaseOptions | undefined {
  const connectionString = process.env.DATABASE_URL;
  return connectionString === undefined ? undefined : { connectionString };
}

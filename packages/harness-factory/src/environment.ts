/**
 * Durable-environment binding for a single composed harness run (OIK-207).
 *
 * The binding describes substrate state that outlives this harness instance;
 * it does not make the harness itself persistent. Connector sessions remain
 * owned by the injected pool, whose acquire/release lifecycle is deliberately
 * exposed without a destroy operation.
 */

/** Structural contract supplied by @oikonomos/connectors (OIK-208). */
export interface ConnectorSessionPool {
  acquire(tenantId: string, connectorId: string): Promise<unknown>;
  release(handle: unknown): void;
}

export interface RunIdentity {
  readonly runId: string;
  readonly roleId: string;
  readonly tenantId: string;
}

export interface EnvironmentOptions {
  readonly workspaceRoot: string;
  readonly roleId: string;
  readonly roleDir: string;
  readonly sessionPool?: ConnectorSessionPool;
}

/** The durable identity included with this run's audit context. */
export interface EnvironmentAuditIdentity extends RunIdentity {
  readonly workspaceRoot: string;
  readonly roleDir: string;
}

export interface BoundEnvironment extends EnvironmentOptions {
  readonly auditIdentity: EnvironmentAuditIdentity;
}

/**
 * Validates and freezes the environment binding for one composed run.
 * A durable role identity must agree with the identity sent to the broker,
 * otherwise the run would carry contradictory audit attribution.
 */
export function bindEnvironment(run: RunIdentity, environment: EnvironmentOptions): BoundEnvironment {
  requireNonEmpty(run.runId, "run.runId");
  requireNonEmpty(run.roleId, "run.roleId");
  requireNonEmpty(run.tenantId, "run.tenantId");
  requireNonEmpty(environment.workspaceRoot, "environment.workspaceRoot");
  requireNonEmpty(environment.roleId, "environment.roleId");
  requireNonEmpty(environment.roleDir, "environment.roleDir");

  if (environment.roleId !== run.roleId) {
    throw new Error("environment.roleId must match run.roleId");
  }

  return Object.freeze({
    workspaceRoot: environment.workspaceRoot,
    roleId: environment.roleId,
    roleDir: environment.roleDir,
    sessionPool: environment.sessionPool,
    auditIdentity: Object.freeze({
      runId: run.runId,
      roleId: environment.roleId,
      tenantId: run.tenantId,
      workspaceRoot: environment.workspaceRoot,
      roleDir: environment.roleDir,
    }),
  });
}

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

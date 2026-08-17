/**
 * Canary runner workspace (@oikonomos/evals-harness).
 * Tests live in ./test and are invoked by the root `pnpm canaries` script.
 */
export const workspaceName = "evals-harness";

export function ping(): string {
  return workspaceName;
}

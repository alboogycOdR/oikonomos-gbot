import { SandboxClientError } from "./errors.js";

const SECRET_SCHEME = "secret://";

/**
 * Resolves a `secret://…` ref to its value. Same convention as
 * `packages/connectors/src/mcp/envSecretResolver.ts` (there is no existing
 * `secret://` convention for the OpenSandbox API key — `infra/sandbox/README.md`
 * documents no `OIK_SECRET_*` usage for it — so this task establishes one by
 * mirroring the pattern already used for every other credential in this repo,
 * rather than inventing a new shape or reading an undocumented ad hoc env var).
 * Callers inject their own resolver (e.g. a vault-backed one); the default
 * export below is the same env-var-derived resolver connectors already use.
 */
export type SecretResolver = (ref: string) => Promise<string>;

/**
 * Derive the process env key for a secret ref.
 * `secret://opensandbox/api_key` → `OIK_SECRET_OPENSANDBOX_API_KEY`.
 */
export function envKeyFromSecretRef(ref: string): string {
  const body = ref.startsWith(SECRET_SCHEME) ? ref.slice(SECRET_SCHEME.length) : ref;
  const mapped = body
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return `OIK_SECRET_${mapped}`;
}

/** The documented ref for the OpenSandbox API key (see infra/sandbox/README.md §1 Auth). */
export const OPENSANDBOX_API_KEY_REF = "secret://opensandbox/api_key";

/**
 * Default SecretResolver: read `process.env[OIK_SECRET_…]` derived from the ref.
 * Unset or empty throws naming the REF, never a value (N4) — the thrown message
 * never interpolates process.env content.
 */
export const envSecretResolver: SecretResolver = async (ref: string): Promise<string> => {
  const key = envKeyFromSecretRef(ref);
  const value = process.env[key];
  if (value === undefined) {
    throw new SandboxClientError(`secret ref is unset: ${ref}`, "SECRET_UNSET");
  }
  if (value.length === 0) {
    throw new SandboxClientError(`secret ref resolved to an empty value: ${ref}`, "SECRET_EMPTY");
  }
  return value;
};

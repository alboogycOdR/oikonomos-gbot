/**
 * TASK-056 / Directive §4 N4 — approval nonces are single-use bearer
 * secrets in URL form (`/approvals/:nonce/decide`, and as of TASK-063
 * `/approvals/:nonce/edit`). Fastify's default pino request serializer
 * logs the raw request URL, which would put the nonce in every log line
 * for these routes. `redactApprovalNonceFromUrl` replaces the path
 * segment before it ever reaches the logger; request bodies are never
 * logged at all (no serializer reads `req.body`), covering both routes'
 * JSON bodies the same way.
 */
const APPROVAL_NONCE_URL_RE = /^(\/approvals\/)[^/?]+(\/(?:decide|edit).*)$/;

export function redactApprovalNonceFromUrl(url: string): string {
  return url.replace(APPROVAL_NONCE_URL_RE, "$1[REDACTED]$2");
}

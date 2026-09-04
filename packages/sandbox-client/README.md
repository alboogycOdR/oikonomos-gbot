# @oikonomos/sandbox-client

Thin, typed HTTP client for the real, deployed OpenSandbox Lifecycle API
(`infra/sandbox/README.md`, OIK-042 — `http://100.78.70.2:8080`, Tailscale-only,
Docker backend per `docs/decisions/ADR-006-addendum-b-opensandbox-adoption.md` R16).

**Wave-1 scope only (OIK-113/114 epic, first slice).** Covers connectivity and
basic lifecycle control: health check, create sandbox, destroy sandbox.
Browser trace capture and routine-spec generation are explicitly out of scope
here — later tasks once this foundation exists.

## Types verified against the live server

The request/response shapes in `src/types.ts` were read from the real
deployed server's own OpenAPI spec (`GET /openapi.json` against
`100.78.70.2:8080`), not guessed from the README alone — the README documents
the deployment, not the wire format. Only the fields this client uses are
typed; the server may return additional fields.

## Secret handling

The OpenSandbox API key has no existing `secret://` ref convention elsewhere
in this repo (`infra/sandbox/README.md` documents no `OIK_SECRET_*` usage for
it). This package establishes one, mirroring the pattern
`packages/connectors/src/mcp/envSecretResolver.ts` already uses for every
other credential:

- Ref: `secret://opensandbox/api_key` (exported as `OPENSANDBOX_API_KEY_REF`).
- Default resolver (`envSecretResolver`) reads `process.env.OIK_SECRET_OPENSANDBOX_API_KEY`.
- Callers can inject any other `SecretResolver` (e.g. vault-backed) via
  `createSandboxClient({ resolveApiKey })` — the client never hardcodes a key
  and never reads an undocumented ad hoc env var name.

The key is sent only as the literal `OPEN-SANDBOX-API-KEY` request header. It
is never interpolated into a thrown `Error` message, a log line, or a test
fixture (CLAUDE.md non-negotiable 4) — see `test/sandboxClient.test.ts` for
tests asserting this directly.

## Usage

```ts
import { createSandboxClient } from "@oikonomos/sandbox-client";

const client = createSandboxClient({ baseUrl: "http://100.78.70.2:8080" });
// resolveApiKey defaults to reading OIK_SECRET_OPENSANDBOX_API_KEY

await client.health(); // { status: "healthy" }

const sandbox = await client.createSandbox({
  image: { uri: "python:3.11" },
  entrypoint: ["python", "/app/main.py"],
  resourceLimits: { cpu: "500m", memory: "512Mi" },
  timeout: 300,
});

await client.destroySandbox(sandbox.id);
```

## Testing

- `test/sandboxClient.test.ts`, `test/secretResolver.test.ts` — unit tests
  against a fake `fetch` transport (`FetchLike`), no network access.
- `test/sandboxClient.integration.test.ts` — optional, gated behind
  `SANDBOX_INTEGRATION_URL` + `OIK_SECRET_OPENSANDBOX_API_KEY` env vars,
  mirroring the `DATABASE_URL`-gated `describe.skip` pattern used elsewhere in
  this repo (e.g. `packages/approvals/src/decide.test.ts`). Skips cleanly
  wherever Tailscale connectivity or the real key isn't available.

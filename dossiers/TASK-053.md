# TASK-053 - Manifest to MCP server config (secret refs, never literals)

## Brief
Convert a validated manifest's `mcp_server` block into the `McpServerConfig` shape TASK-052 added, resolving `url_ref: secret://...` through an injected `SecretResolver` port.

## Spec pointers
- Build Handover 4.4 - `mcp_server: { name, transport, url_ref: secret://mcp/gmail/url }`. The manifest carries a *reference*, never a value.
- N4 - no credential in prompts, logs, audit payloads, or fixtures. An unset secret throws naming the **ref**, never the value.
- N5 - refuse to build a config for a non-`basileia` manifest (defence in depth; the validator already rejects it).

## Intended approach
Default resolver maps `secret://mcp/gmail/url` to `OIK_SECRET_MCP_GMAIL_URL`. Fail closed on empty resolution. Mutation to run: make the unset-secret path return an empty config instead of throwing - a test must go red.

## Work Log

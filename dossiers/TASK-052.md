# TASK-052 - Live MCP server mount in composeHarness (PROTECTED)

## Brief
`ComposeOptions` has **no MCP surface at all** - that is why zero connectors are live despite Gmail being "onboarded". Add `mcpServers` to `composeHarness` (and nowhere else, N9) so `mcp__*` tools exist at runtime, and prove they traverse L1 exactly like built-in tools.

## Spec pointers
- ADR-001 - L1 PreToolUse is *the* enforcement point; an MCP tool is not a special case and must not get its own path.
- OIK-033 / N9 - composeHarness is the sole harness constructor. The SDK option is set there only.
- N4 - secrets arrive pre-resolved from the caller (TASK-053 resolves them); this package never reads env, never logs config, and no error message echoes a url/header value.

## Intended approach
`src/mcp/` holds the config types; thread `mcpServers` through `composeHarness` into the SDK options object. Test with a **fake in-process MCP transport** - no network, no credentials. The decisive test is an L1 deny of an `mcp__*` call actually preventing it; the decisive mutation is bypassing L1 for `mcp__` names.

**Protected path:** GB or CX only, never S5. If the SDK's MCP surface seems to require changes in `hooks/` or the L1/L2/L3 adapters, BLOCK with SPEC_AMBIGUITY rather than widening territory.

## Work Log

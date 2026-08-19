# TASK-054 - Live enumeration + allowedTools derivation

## Brief
Two halves: (1) back TASK-045's `enumerateTools` with a **real** `listTools()` from a mounted MCP server; (2) derive the L2 allowlist from the manifest map - fully-qualified `mcp__server__tool` names only.

## Spec pointers
- ADR-001 L2 - explicit allowedTools, **never bare names**; CAN-02 exists because a bare name once bypassed enforcement.
- WBS 4 G-CONN - `enabled: false` capabilities (e.g. `email.send`) must not appear in the allowlist. This is how Gmail's send stays unreachable while its gate is closed.
- Handover 4.2 - unmapped implies deny.

## Intended approach
The allowlist is **defence in depth, not the enforcement point** - prove it: a tool omitted from the allowlist must ALSO be denied by L1 if called. Mutation: let `enabled: false` capabilities into the allowlist, and the `email.send` test goes red.

**Credentials:** the live half needs a provisioned MCP endpoint. If it is absent, finish the derivation half and BLOCK with `MISSING_DEPENDENCY: live MCP credentials not provisioned` - do not fake a live run.

## Work Log

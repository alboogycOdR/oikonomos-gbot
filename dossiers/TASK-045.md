# TASK-045 — OIK-049 Tool enumeration + capability auto-mapping

## Brief
Compare what an MCP server actually exposes against the manifest's tool→capability map. Unmapped tool ⇒ check fails AND runtime deny is proven via the existing policy fail-closed path. Output is a JSON report ORCH attaches to the OIK-050 onboarding record.

## Spec pointers
- WBS OIK-049: "Every MCP tool mapped to a capability with an explicit tier; unmapped ⇒ deny".
- Handover §4.2: unregistered toolName ⇒ deny, audited `capability.unregistered` — that deny already exists in packages/policy; your job is to PROVE it fires for unmapped tools, not to rebuild it.
- ADR-005: empty enumeration fails as unobservable.

## Intended approach
- `src/enumeration/` with an injected `listTools(): Promise<string[]>` port — no live MCP in tests.
- Report: mapped[], unmapped[] (fail), stale[] (manifest tool no longer exposed — warn only).
- One test drives real policy resolution with an unmapped name and asserts deny (consume packages/policy public API read-only; missing API ⇒ block, do not edit policy/broker).
- Mutation: unmapped-as-pass → test red.

## Work Log

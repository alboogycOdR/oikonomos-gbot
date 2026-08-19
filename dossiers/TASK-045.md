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

- [2026-08-18T19:15:00Z] [GB] Resumed claimed TASK-045 on `task/TASK-045-gb` (no re-claim). Preflight (c8b9872):
  ```
  [preflight] TASK-045 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-grok-oikonomos
  [preflight] 2 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    GLOB   packages/connectors/src/**  -> 7 file(s):
             packages/connectors/src/index.ts
             packages/connectors/src/manifest/cli.ts
             packages/connectors/src/manifest/scan.ts
             packages/connectors/src/manifest/schema.ts
             packages/connectors/src/manifest/urlRef.ts
             packages/connectors/src/manifest/validate.ts
             packages/connectors/src/registration/index.ts
    GLOB   packages/connectors/test/**  -> 6 file(s):
             packages/connectors/test/cli.test.ts
             packages/connectors/test/fixtures/gmail.handover.yaml
             packages/connectors/test/helpers.ts
             packages/connectors/test/registration.test.ts
             packages/connectors/test/scan.test.ts
             packages/connectors/test/schema.test.ts
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```
  Policy public API exists (`resolveCapabilityTier` → deny `capability.unregistered`). `package.json` is outside Owned_Paths so the deny test will import the policy public module via relative path, not add a workspace dep. Next: implement `src/enumeration/` + tests.

- [2026-08-18T19:18:53Z] [GB] Enumeration check landed. `enumerateTools(manifest, {listTools})` writes mapped/unmapped/stale JSON; unmapped fails and names tools; stale warns only; empty listTools is UNOBSERVABLE. Runtime deny proven via real `resolveCapabilityTier` (capability.unregistered). Mutation `ok = true` reddened 4 tests; restored. Connectors 34/34. `pnpm -r test` 0, `pnpm lint` 0, `pnpm canaries` 15 pass / 2 skip. Ready for review.


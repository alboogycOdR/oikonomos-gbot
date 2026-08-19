# TASK-055 - End-to-end governed inbox-triage run (integration, single owner)

## Brief
`services/worker` is the **shared seam** between the runtime and surface lanes, so it has exactly one owner - you. Extend `executeTaskRun` to mount a connector's MCP server with the derived allowlist, then prove the whole chain in one run.

## Spec pointers
- Directive 5 DoD - Functional (real workflow), Governed (every action through the broker), Evidenced (what data, what actions, what was denied).
- ADR-005 - the existing liveness assertion keys on a broker decision audit event; extend it to the MCP path so the control dies if MCP calls stop reaching the broker.
- OIK-038 - run lifecycle: session_ref persisted, terminal state reached.

## Intended approach
The money test: T0 list + T1 draft succeed, T3 send is **denied and audited**, in a single run. CI-green version uses fake queryFn + fake MCP transport; record a real run too if credentials exist. Do not modify `packages/**` - if the runtime lane left a gap, BLOCK rather than patch from here.

## Work Log

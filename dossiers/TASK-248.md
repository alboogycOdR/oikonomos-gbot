# TASK-248 — Workspace-1 follow-on — web Computer view: read-only live view in the dashboard; interactive only after TASK-235

**Unit:** TBD · **Priority:** medium · **Depends_On:** TASK-243, TASK-245

## Brief
Read-only first. Prerequisite evidence: acceptance case C01 (TASK-245) must have passed on mobile — the PTY id is assumed equal to the sandbox id (`ports.ts:310-317`) and no PTY-create exists in `packages/sandbox-client`; if C01 fails, this task is blocked on that finding, not built around it. Add an origin check to the WebSocket upgrade in `liveAgent.routes.ts` (the web client is same-origin behind TASK-240's proxy), a dashboard client mirroring the mobile `LiveAgentClient`, and a Computer view showing connection state, last update time, and the stream. Interactive input waits for TASK-235 (CDP hand-off + exclusivity proof); the view must say so explicitly rather than showing a disabled control.

## Spec pointers
specs/OIKONOMOS_WORKSPACE_WAVE_v1.0.md §9.4; TASK-171; TASK-228; TASK-235

Read `specs/OIKONOMOS_WORKSPACE_WAVE_v1.0.md` §1 first for the product shape and §10 for what must not be claimed. The independent review that produced this wave (verdict, disposition matrix, execution proposal) is at `E:\DELL-PROJECTS\GROKBOT-RESEARCH-DOCS\ORCH_REVIEW\` — read the rows cited in Spec_References; do not treat the advisory documents themselves as spec.

## Intended approach
Read-only first. Prerequisite evidence: acceptance case C01 (TASK-245) must have passed on mobile — the PTY id is assumed equal to the sandbox id (`ports.ts:310-317`) and no PTY-create exists in `packages/sandbox-client`; if C01 fails, this task is blocked on that finding, not built around it. Add an origin check to the WebSocket upgrade in `liveAgent.routes.ts` (the web client is same-origin behind TASK-240's proxy), a dashboard client mirroring the mobile `LiveAgentClient`, and a Computer view showing connection state, last update time, and the stream. Interactive input waits for TASK-235 (CDP hand-off + exclusivity proof); the view must say so explicitly rather than showing a disabled control.

## Owned_Paths
apps/dashboard/src/components/workspace/computer/**, apps/dashboard/src/lib/liveAgent.ts, apps/dashboard/src/lib/liveAgent.test.ts, services/control-api/src/liveAgent.routes.ts, services/control-api/src/liveAgent.routes.test.ts

## Work Log

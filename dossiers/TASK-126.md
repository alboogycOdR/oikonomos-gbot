# TASK-126 Dossier

## Work Log

- [2026-09-04T09:30:00Z] [CX] Inspected the TASK-126 API and UI territory plus TASK-122's live fan-out mechanism. Blocked before implementation: `deliverBotToBotMessage` is implemented in `services/worker/src/chatRunDriver.ts` but is not exported from `services/worker/src/index.ts`. `services/control-api/src/ports.ts` can only legally consume the worker package public API; reimplementing approval issuance in control-api would violate the task's explicit requirement to reuse the TASK-122 mechanism. Exporting the function and its request/result types requires `services/worker/src/index.ts`, outside TASK-126 Owned_Paths. No production files changed.

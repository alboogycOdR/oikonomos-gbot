# TASK-360 dossier

**Brief:** Make the broker's legacy branch honour enabled Require-Approval rules, so Auto-review (TASK-350) actually gates T1 tools. It only adds approvals and fails closed. Protected path: ORCH reviews as the different model.

**Pointers:** packages/broker/src/index.ts ~L691-718; resolveApprovalRequired; packages/policy requireApproval matcher; enforcementGate.ts shows how the gate consumes requireApprovalRules.

## Work Log

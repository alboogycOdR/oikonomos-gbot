# TASK-059 - Evidence delivery with the approval (OIK-087)

## Brief
Attach what the operator needs to decide: the draft body and recipient, plus the artifact URIs PostToolUse recorded. Fetched from control-api, never the DB or filesystem.

## Spec pointers
- OIK-087 - "Screenshots/diffs delivered with the approval request".
- Directive 5 Evidenced - truncation must be **visible**; a silently truncated draft means approving something you did not fully see, which defeats the approval.
- N4 - reuse `packages/audit`'s redaction; never write a second implementation.

## Work Log

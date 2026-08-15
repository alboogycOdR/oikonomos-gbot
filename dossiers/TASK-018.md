# TASK-018 — OIK-003 CODEOWNERS + protected-path CI enforcement ⚑ protected

**Brief:** Make the protected-path rule mechanical instead of convention-plus-review. CODEOWNERS covering the protected paths, plus a local check that fails a diff touching them without the required review.

**Spec pointers:** WBS OIK-003. Handover §3 and CLAUDE.md for the authoritative protected-path list. TASK-004 set the no-remote precedent: demonstrate acceptance via a locally runnable script.

**Intended approach:** Be honest about the limit — CODEOWNERS is inert without a GitHub remote, so the local script is the operative control until one exists, and the README must say so rather than implying coverage that is not there. Self-test both directions.

## Work Log
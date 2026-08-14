# TASK-003 — OIK-017/018 packages/shared: canonical JSON + sha256 digest

**Brief:** The platform's single canonical-JSON and action-digest implementation (N10). Every approval binding and broker digest depends on byte-level stability of this code; precision over speed.

**Spec pointers:** Handover §4.3 (the contract: sorted keys, no whitespace, UTF-8, shortest round-trip numbers; digest = sha256(canonicalJson({toolName, input, destination}))). WBS OIK-017/018 acceptance. N10 (single implementation, packages/shared). N4 (no credential-like fixture values).

**Intended approach:** src/canonicalJson.ts + src/actionDigest.ts, Node crypto only, zero runtime deps. Explicit edge-case decisions documented in README.md byte-level spec: -0 normalization, exponent form, unicode (no NFC normalization — bytes as given, state it), null vs absent, reject NaN/Infinity/undefined/functions/symbols with typed error. Property tests (fast-check is a dev dep at root if TASK-001 provided it; otherwise hand-rolled generators — do NOT edit package.json, it is TASK-001 territory; block OWNERSHIP_CONFLICT if a manifest change is truly essential). Child-process reproducibility test.

## Work Log

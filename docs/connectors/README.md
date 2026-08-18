# Connector onboarding records (OIK-050)

One record per connector: `docs/connectors/<connector_id>.md`, written by ORCH at review time
(this directory is outside builder territory — see ADR-008). The machine manifest lives at
`packages/connectors/manifests/<connector_id>.yaml`.

## Scope-minimisation checklist — every record must answer all of these

1. **Ownership (N5):** which Basileia-owned account does this connector resolve to? `account_ownership: basileia` confirmed in the manifest; any client/employer/third-party target ⇒ REJECT.
2. **Scopes:** every OAuth scope listed, each with a one-line justification tied to a capability. Any scope with no consuming capability ⇒ remove it.
3. **Tier map:** every MCP tool mapped to a capability with an explicit tier; the rationale for each Tier-3 (`T3_external`) assignment stated. Unmapped tools deny by default — confirmed against the OIK-049 enumeration report.
4. **Wave-1 restrictions:** externally-visible send/write capabilities present but `enabled: false` until this connector's G-CONN opens (evals ≥90%).
5. **Evals:** golden suite path, pass rate at onboarding, date of the run.
6. **Reversal:** how registration is undone (deregistration run recorded) and how the connector is killed at runtime (capability kill switch).
7. **Decision:** onboarded by, date, and the explicit G-CONN status (open/closed) at time of writing.

## Record template

```markdown
# <connector_id> — onboarding record
- Account (N5):
- Scopes + justification:
- Tier map notes (T3 rationale):
- Disabled-until-G-CONN capabilities:
- Evals: suite, pass rate, run date:
- Reversal path:
- Decision: onboarded_by / date / G-CONN status:
```

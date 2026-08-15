# ADR-004 — `action_render` must be derived from the payload, never supplied by the caller

**Status:** ACCEPTED · **Date:** 2026-08-15 · **Decision owner:** Alister Witbooi
**Amends:** Platform Synthesis Spec §5.1 (`action_render` column comment); fills a silence in Build Handover §4.3
**Binding on:** OIK-021 (TASK-013), OIK-022 (TASK-014), OIK-023/024 (TASK-015), OIK-027 (TASK-016)

---

## Context

`approvals.action_render` is the human-readable text a person actually reads before granting a
Tier-3 action. It is the entire basis of the yes.

Its provenance is unspecified. A grep of `docs/architecture/`, `docs/decisions/` and `specs/`
finds exactly one mention repo-wide — a SQL comment at Synthesis Spec §5.1 line 214:

```sql
action_render text NOT NULL,   -- human-readable: destination + content/param diff
```

Build Handover §4.3, which governs under CLAUDE.md document precedence, pins the digest formula
(`sha256(canonicalJson({toolName, input, destination}))`) and says nothing about the render at all.
TASK-013's acceptance criterion requires only that the row "carries" it. So nothing currently
prevents `action_render` from being free text chosen by whatever composes the approval.

**The gap this leaves.** `action_digest` binds the *payload*. It does not bind the *render*.
Two failure modes are therefore not symmetric:

| Failure | Caught? | By what |
|---|---|---|
| Payload mutated *after* the grant | Yes | Recomputed digest mismatches → `invalidated` (OIK-023, ADR-001 CAN-07) |
| Render *misleading at issuance* | **No** | Digest is perfectly valid; the human simply approved a description of something else |

A render saying "email Bob about lunch" attached to a payload addressed to Eve produces a
correct digest, a valid nonce, a clean atomic consume, and a complete audit trail — of the wrong
action, approved by a human who was never shown it. Every mechanical control passes. The gate is
defeated without ever being tripped.

**External evidence that this is the realistic failure, not a theoretical one.** Grok Bot, asked
directly about its own approval surface (2026-08-15), self-reported precisely this architecture and
was explicit about the consequences:

- its approval render is model-authored prose which "can summarize, omit, or be precise", quality
  being "the model's judgment that turn";
- "Nothing downstream checks the widget prose against what later runs. The text is advisory.";
- the approval carries "no tool name, no arguments, no payload hash, no bound call" — clicking yes
  "does not authorize a call", it "authorizes me, conversationally, to proceed";
- consequently "'the payload changed between yes and execute' is not a concept this surface has …
  A change is not a violation because nothing was sealed";
- and, unprompted: **"If you need 'what they saw is what ran,' that has to be your broker. It is
  not here."**

OIKONOMOS's digest binding already answers the second half of that — the payload *is* sealed here.
This ADR closes the first half, so that the sealed payload is also the one described.

## Decision

**`action_render` is a pure, deterministic function of the same canonical payload that
`action_digest` covers. It is never accepted as caller-supplied input.**

1. **Derivation, not parameter.** `insertApproval` and any future issuance path MUST compute the
   render from `{toolName, input, destination}`. No issuance API may expose a `render` argument.
   Anything that accepts render text from its caller is a defect regardless of test results.

2. **Same input as the digest, one implementation.** The render is computed from the identical
   canonical form `packages/shared` already produces for the digest (N10 — canonical JSON and
   digest have exactly one implementation, in `packages/shared`). The render function lives beside
   `actionDigest` in `packages/shared` and consumes the same canonicalized object, so render and
   digest are provably about the same bytes. A second canonicalization path would reintroduce the
   divergence this ADR exists to remove.

3. **Deterministic and reproducible.** Equal payloads yield byte-identical renders, across
   processes, following the same discipline TASK-003 established for the digest. This makes the
   render independently recomputable at review, consume, or audit time.

4. **Content it must carry.** At minimum the destination and the content/parameter diff, per the
   §5.1 comment this ADR ratifies. Where the payload is large the render may elide, but elision
   must be visible (an explicit truncation marker), never silent.

5. **Testable property.** The implementing task carries a test proving that a change to any
   digest-covered field changes the render. That is the discriminating assertion: it fails for any
   implementation where the render is decorative, constant, or caller-controlled.

## Consequences

- **Positive.** "What they saw is what ran" becomes structural rather than trusted. A misleading
  render is not discouraged, it is unrepresentable — there is no channel through which one can be
  supplied. Renders also become recomputable, so an auditor can verify after the fact that a stored
  render matches its stored digest.
- **Positive.** Combined with OIK-023, both directions are now closed: the payload cannot change
  after the yes, and the prose cannot have misdescribed it before the yes.
- **Cost.** Callers lose the ability to write a friendlier, context-aware sentence. Render quality
  becomes a property of one shared function that must serve every capability, which is a harder
  engineering problem than letting each call site phrase its own.
- **Residual risk, stated plainly.** Deriving the render guarantees *faithfulness*, not
  *legibility*. A faithful render can still be unreadable — a wall of JSON diff a human skims and
  approves — and this ADR does not fix that. Approval-fatigue and render-comprehension remain open
  and are properly an E9 dashboard concern, not a data-layer one. Do not read this ADR as evidence
  that the human understood; only that they were shown the truth.
- **Cost.** If TASK-013 has already shipped a caller-supplied render, closing it is follow-up work.
  That AC was written without this constraint, so the acceptance criterion is the defect, not the
  builder — remediation belongs with TASK-015 rather than as rework against TASK-013.

## References

- Build Handover Package v1.0 §4.3 (digest formula; silent on render)
- Platform Synthesis Spec v0.1 §5.1 line 214 (`action_render` comment — ratified here)
- ADR-001 — Broker enforcement point (CAN-06 atomic consume, CAN-07 invalidation on mutation)
- ADR-003 — Tier resolution direction (precedent: a spec gap on a security-critical field recorded
  before its consuming task, so the trap is not re-implemented)
- Grok Bot self-report, 2026-08-15 — external evidence of the unbound-render failure mode in a
  shipping system. Recorded as reported behaviour, not independently verified; no decision here
  rests on it alone.

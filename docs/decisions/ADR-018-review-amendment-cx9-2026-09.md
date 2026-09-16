# ADR-018 amendment adversarial review — CX9, 2026-09

**Subject:** TASK-264 tip `580af46e8388e89a567620659f66bd078506e733` (`task/TASK-264-s5`)

**Reviewer:** CX9 / Codex (GPT), a non-Anthropic model independent of the TASK-264 implementer.

**Verdict:** **Reject.** The named allow-list and live tier lookup are the right mechanism, but this commit cannot merge: it auto-grants the explicitly undecided mutating browser capability, and its new integration test pollutes the isolated registry with obsolete capability IDs.

Evidence was checked against the subject commit and the live `capabilities` tables, not inferred from the implementation dossier.

---

## Review questions

### Q1 — Does the floor exclude every account-linked connector capability?

**The implementation does; the proof does not.** The allow-list contains only filesystem, runtime, Steel, and workspace IDs ([`defaultCapabilities.ts:33`](../../services/control-api/src/defaultCapabilities.ts#L33)-[`48`](../../services/control-api/src/defaultCapabilities.ts#L48)); it names no Gmail, Calendar, or Drive ID. A read-only live query of the production `capabilities` table found account-linked IDs under `mcp:gmail` (`email.list`, `email.create_draft`, `email.send`), `mcp:google-calendar` (`calendar.*`), and `mcp:google-drive` (`drive.*`), none of which are in that list.

However, the claimed database proof hardcodes non-manifest IDs `gmail.send_message`, `google-calendar.create_event`, and `google-drive.create_file` ([`app.test.ts:33`](../../services/control-api/src/app.test.ts#L33)-[`38`](../../services/control-api/src/app.test.ts#L38), [`64`](../../services/control-api/src/app.test.ts#L64)-[`76`](../../services/control-api/src/app.test.ts#L76)). Those are not the live registered connector IDs above, so this is not an assertion over *every* account-linked capability.

### Q2 — Is `workspace.request_secret` excluded, and why does that matter?

**Yes, in the implementation.** It is absent from the closed allow-list ([`defaultCapabilities.ts:33`](../../services/control-api/src/defaultCapabilities.ts#L33)-[`48`](../../services/control-api/src/defaultCapabilities.ts#L48)), so the filter at [`app.ts:1167`](../../services/control-api/src/app.ts#L1167)-[`1179`](../../services/control-api/src/app.ts#L1179) cannot write a standing grant for it. That is the required boundary: a grant would let every newly created bot invoke the human-facing credential-request flow, turning an explicitly supervised hand-off into an automatic default. The test does seed and check this one real ID ([`app.test.ts:64`](../../services/control-api/src/app.test.ts#L64), [`121`](../../services/control-api/src/app.test.ts#L121)-[`127`](../../services/control-api/src/app.test.ts#L127)).

### Q3 — Should `browser.interact` be in every new role's floor?

**No. Remove it pending an explicit human product/security decision.** The amendment deliberately leaves this T2, mutating click/type/fill capability undecided. Yet TASK-264 includes it ([`defaultCapabilities.ts:42`](../../services/control-api/src/defaultCapabilities.ts#L42)) and grants it automatically at `T2_internal` ([`app.test.ts:56`](../../services/control-api/src/app.test.ts#L56), [`117`](../../services/control-api/src/app.test.ts#L117)). A Basileia-owned browser session avoids a personal-account grant, but does not remove the capability to submit forms or otherwise mutate a live site. It should remain manual-grant-only while the four session/read-only Steel capabilities can join the floor.

Removing it also resolves the task text's “ten” count: the current list is actually eleven entries ([`defaultCapabilities.ts:35`](../../services/control-api/src/defaultCapabilities.ts#L35)-[`47`](../../services/control-api/src/defaultCapabilities.ts#L47)); three original + four non-mutating Steel + three workspace capabilities is ten.

### Q4 — Can a template integration make the grant checklist misleading?

**Not in the current repository, because no template install or `integrations[]` implementation exists.** `git grep` at the subject commit found no `POST /templates/:id/install`, `bot_templates`, or template package. The reviewed route only creates a role and grants the filtered floor ([`app.ts:1153`](../../services/control-api/src/app.ts#L1153)-[`1180`](../../services/control-api/src/app.ts#L1180)); it does not parse a template or produce a checklist. Thus no current smuggling path exists, but neither does the amendment's required future invariant. The future templates task must reject any `integrations[]` member in `DEFAULT_ROLE_CAPABILITIES`, rather than displaying it as a grant a human must still approve.

### Q5 — Is default-tier resolution live, rather than hardcoded?

**Yes.** `POST /roles` obtains the current capability records through `deps.listCapabilities()` ([`app.ts:1167`](../../services/control-api/src/app.ts#L1167)-[`1169`](../../services/control-api/src/app.ts#L1169)) and writes each selected row's `defaultTier` ([`app.ts:1170`](../../services/control-api/src/app.ts#L1170)-[`1179`](../../services/control-api/src/app.ts#L1179)). The database-backed dependency maps that call to `database.listCapabilities()` ([`ports.ts:512`](../../services/control-api/src/ports.ts#L512)). No tier literal appears in the production allow-list.

## Required changes

1. Remove `browser.interact` from `DEFAULT_ROLE_CAPABILITIES` and from all corresponding test expectations. Do not re-add it without a recorded human decision that explicitly accepts its automatic T2 standing grant.
2. Rewrite `app.test.ts` to inspect the initialized, manifest-registered capability rows and assert that every Gmail/Calendar/Drive row is absent from the created role's grants. Do not manufacture connector capability IDs. The existing test permanently inserts stale IDs and closes only the app ([`app.test.ts:69`](../../services/control-api/src/app.test.ts#L69)-[`80`](../../services/control-api/src/app.test.ts#L80), [`128`](../../services/control-api/src/app.test.ts#L128)-[`130`](../../services/control-api/src/app.test.ts#L130)); the live isolated table now contains `gmail.send_message`, `google-calendar.create_event`, and `google-drive.create_file`, demonstrating this contamination directly. This can produce `StaleCapabilityRowError` in later registry consumers.
3. After the future template installer is implemented, add the amendment's integration-list invariant: reject a template whose `integrations[]` contains any `DEFAULT_ROLE_CAPABILITIES` member, and test it at the database/route boundary. This is deferred only because the route/package is absent, not because the invariant is optional.

## Verdict rationale

The explicit ID allow-list is substantially safer than an adapter-tag filter, and live tier resolution is correct. But the deliberate review question on a mutating browser tool has not been resolved safely, while the new test writes stale registry rows that are observable in the isolated database. Both must be fixed before this grant-boundary change is accepted.

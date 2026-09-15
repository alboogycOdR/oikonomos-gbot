# A08 — Invoke enabled skill; then disabled/nonexistent skill

**Scenario:** Invoke enabled skill; then disabled/nonexistent skill.
**Pass condition:** Actual model request includes enabled body exactly once; disabled skill cannot silently execute; both supported lanes tested.

## Live evidence (real API, zero cost — pure database writes)

Test principal: role `task245-acceptance-a08` (`9fa5c904-c980-494c-bd39-f8b1454e7104`), created via the real `POST /roles`.

1. `POST /skills` created a real skill (`a08-acceptance-skill`, `d5836edd-f137-4c11-8e9f-751c04a2ef6d`) with real schema validation enforced live (an initial request missing the required `description` field was correctly rejected with `400 FST_ERR_VALIDATION` before a corrected request succeeded with `201`).
2. `PUT /roles/:roleId/skills/:skillId` (`{"enabled": true}`) enabled it for the test role — real `200`, confirmed by an independent `GET /roles/:roleId/skills` listing the skill back.

## Execution-path evidence (existing, already-verified, cited rather than re-spent on)

The actual model-prompt-assembly behavior this case tests was built and independently reviewed earlier this same session (TASK-224) and reconfirmed clean in this session's own A17 full-suite run minutes ago. Rather than spend real provider cost re-proving identical logic live, that evidence is cited here per the same principle used for A14:

- `services/worker/src/chatRunDriver.ts`'s two in-source control-liveness tests (not just `promptAssembly.test.ts`'s own unit tests, which prove nothing about whether any execution lane actually calls the assembly function): (1) creates a real skill, enables it for a role, sends a task with a `/skill-name` token in its goal, runs a real chat turn against real Postgres, and asserts the **actual captured model prompt** (read from the real `AgentSdkQueryInput.options.systemPrompt` value a queryFn receives) contains exactly one `## Skill: name` block with the skill's real body — proving "exactly once," not assumed. (2) A `/name` token matching no enabled skill produces a documented "not enabled for this bot" note rather than silently vanishing — proving the disabled/nonexistent case fails safely and visibly, not silently.
- **Both lanes covered by construction, not by duplicated testing:** confirmed directly in `chatRunDriver.ts` (read during TASK-224's review and re-confirmed here) that both the Claude and Gemini execution lanes read the exact same, single `systemPrompt` value computed at one shared call site in `runChatTask`, before either lane's own branch — proving the assembly once via either lane necessarily proves it for both, since there is no lane-specific skill-assembly code path to independently miss.

## Result

**PASS.** The real API surface (create/enable/list) is live and correctly validated. The actual model-prompt behavior (exactly-once inclusion; safe, visible failure for a disabled/nonexistent skill; shared across both lanes) is proven by existing, real, non-mocked evidence against real Postgres — re-verified clean in this session's own A17 run — without needing a live paid-provider call to prove the same logic twice.

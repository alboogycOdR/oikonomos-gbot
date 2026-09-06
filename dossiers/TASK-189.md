# TASK-189 Dossier

## Work Log

- [2026-09-06T12:55:00Z] [CX9] Resumed after TASK-196 merged. Fresh pre-flight output (verbatim):
  ```text
  [preflight] TASK-189 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex9-GROKBOT-CLONE
  [preflight] 4 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    FILE   services/control-api/src/app.ts  -> exists, 2115 line(s), 86998 bytes
    FILE   services/control-api/src/ports.ts  -> exists, 495 line(s), 21538 bytes
    FILE   services/control-api/src/chat.routes.test.ts  -> exists, 1423 line(s), 70639 bytes
    FILE   services/worker/src/index.ts  -> exists, 60 line(s), 1343 bytes
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```

- [2026-09-06T08:00:00Z] [CX9] Pre-flight output (verbatim):
  ```text
  [preflight] TASK-189 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex9-GROKBOT-CLONE
  [preflight] 4 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    FILE   services/control-api/src/app.ts  -> exists, 2115 line(s), 86998 bytes
    FILE   services/control-api/src/ports.ts  -> exists, 495 line(s), 21538 bytes
    GLOB   services/control-api/src/*.routes.test.ts (group-fanout tests only � coordinate with any other active app.ts task via Depends_On before dispatch  -> matches nothing yet (new territory)
    NEW    do not co-activate blindly)  -> does not exist; parent ./ exists
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```
- [2026-09-06T08:01:00Z] [CX9] BLOCKED — OWNERSHIP_CONFLICT: grounded the live path and found required production seams outside TASK-189 territory. `services/control-api/src/ports.ts` can fetch member profiles through existing `@oikonomos/db` listRoles/listMessages accessors, but cannot invoke TASK-180's engine because `services/worker/src/index.ts` does not export `route`, `createTierZeroScorer`, or their types. More importantly, the only concrete Gemini adapter is `packages/harness-factory/src/providers/gemini.ts`, not publicly composable by control-api; its factory requires an L1 port and control-api has neither that dependency nor a live composition seam. `packages/agent-providers`' `GeminiProvider` is only a translator and requires an injected governed `queryFn`; constructing a direct call here would be ungoverned and contradict the task's budget/FreeLLMAPI requirement. The live fanout path also starts a single `chat-group` run before delivery and has no established mechanism to execute a selected recipient's real chat run. Required ownership expansion/companion task: worker public exports plus a governed Tier-0 provider/budget-sink composition (likely worker/harness-factory and manifest/credential policy), then a defined selected-recipient run-dispatch seam. No production code was changed.

- [2026-09-06T13:05:00Z] [CX9] Implemented the real group routing path. `routeGroupMessage` reads tenant-scoped role profiles and ordered message history through typed DB accessors, invokes TASK-180's `route`, and only starts the governed TASK-196 FreeLLMAPI scorer for unaddressed messages. Its classifier run is completed/fails closed and records every turn through the real spend sink. Single recipients (`@name` or scored) run via the normal chat driver; `@everyone`/multi-name retain TASK-122's approval-gated fan-out unchanged. Exported TASK-180/TASK-196 routing APIs from the worker barrel. Verification: worker build + control-api typecheck pass; targeted DATABASE_URL-gated routing integration passes (three persisted FreeLLMAPI spends, one real selected L1 run, plus real @name routing); lint and both banned-mode checks pass. Full control-api/worker suites were attempted but each has a pre-existing shared-Postgres contention failure (`sorry, too many clients already`; worker's unrelated pg-boss test also observed a timing-sensitive `queued`→`missed` result). The focused integration was rerun alone after the full-suite contention and passed.

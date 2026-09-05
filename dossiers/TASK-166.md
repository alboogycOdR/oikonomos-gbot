# TASK-166 — Chat file/image attachments

## Work Log

- [2026-09-05T15:45:00Z] [GB] Session start. `control.mode=strict`: PLAN.md not
  touched. Review_Findings empty (first pass, not rework). No prior dossier.
  Created `task/TASK-166-gb` from detached HEAD (`git checkout -b`). Preflight:

  ```text
  [preflight] TASK-166 Owned_Paths inspected in E:/DELL-PROJECTS/wt-grok-GROKBOT-CLONE
  [preflight] 8 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    NEW    TBD at decompose time — likely packages/db/src/messages.ts  -> does not exist; parent directory E:/DELL-PROJECTS/wt-grok-GROKBOT-CLONE/TBD at decompose time — likely packages/db/src does NOT exist either
    FILE   packages/db/src/messages.test.ts  -> exists, 70 line(s), 3265 bytes
    GLOB   infra/postgres/migrations/**  -> 24 file(s):
             infra/postgres/migrations/001_schema_v1.down.sql
             infra/postgres/migrations/001_schema_v1.up.sql
             ... and 12 more
    FILE   services/control-api/src/app.ts  -> exists, 1162 line(s), 44603 bytes
    FILE   services/control-api/src/ports.ts  -> exists, 248 line(s), 11380 bytes
    GLOB   services/control-api/src/*.test.ts  -> 5 file(s):
             services/control-api/src/auth.test.ts
             services/control-api/src/chat.routes.test.ts
             services/control-api/src/ports.test.ts
             services/control-api/src/pushTransport.test.ts
             services/control-api/src/sse.test.ts
    GLOB   apps/mobile/**  -> 65 file(s):
             apps/mobile/README.md
             ...
    GLOB   possibly services/workspace/src/** if attachments land in the agent-visible workspace  -> matches nothing yet (new territory)
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```

  Preflight parsed the "TBD at decompose time — likely" prefix as a path.
  Treating the listed files as territory: `packages/db/src/messages.ts` (file
  exists; prefix fooled the checker), `messages.test.ts`, migrations,
  control-api `app.ts`/`ports.ts`/`*.test.ts`, `apps/mobile/**`. Not writing
  `services/workspace/src/**` — investigation below shows WORKSPACE_ROOT is
  not a live chat-visible mount, so landing files there would be forcing a
  fit to an aspirational path.

## Design question — is WORKSPACE_ROOT real today?

**Answer: no. It is design-only / future Office-computer path algebra.
Chat runs do not mount it, do not use it as cwd, and would not see a file
landed there.**

Evidence:

1. `services/workspace/src/paths.ts` defines `WORKSPACE_ROOT = "/oikonomos/workspace"`
   as a POSIX string for path classification (D1). The module comment is
   explicit: it is "pure path algebra and never touches disk itself."
2. `infra/compose/docker-compose.office.yml` mounts a named volume at
   `/oikonomos` for `office-model` / `office-browser`, but those services
   are Alpine `tail -f /dev/null` placeholders for the future Office
   computer (Addendum F). They are not the chat execution path.
3. TASK-153's real chat driver (`services/worker/src/chatRunDriver.ts`)
   creates `mkdtemp(join(tmpdir(), "oikonomos-chat-${runId}-"))` as `cwd`,
   passes that to the Agent SDK, then `rm`s it in `finally`. The agent's
   Read/Bash tools therefore see a fresh per-run temp directory, not
   `/oikonomos/workspace`.
4. The agent prompt is `request.task.goal` — the control-api sets that
   from the posted message body. No worker change is required to put
   attachment content/paths in front of the model.

Chosen delivery (authorized by the task text: "injecting the file's
content or a reference directly into the prompt/context"):

- Persist bytes to a local object store (`OIK_ATTACHMENTS_DIR`, default
  `{tmpdir}/oikonomos-attachments/{threadId}/{id}.bin`).
- Record a structured attachment array on the message (JSONB column, not
  a blob stuffed into `body`).
- At send time, inject filename/type/size, the absolute storage path
  (Read/Bash can reach host paths outside cwd per TASK-153), and inlined
  UTF-8 text for small text files, into `task.goal`.
- Do **not** write `services/workspace` — that would pretend the Office
  volume is the chat cwd.

## Implementation notes

Limits (server-side, not just client): 10 MiB decoded, 10 files/message,
allow-list `image/jpeg|png|gif|webp`, `text/plain|markdown|csv`,
`application/json|pdf`. Rejection message names the rule.

Upload is JSON `{filename, contentType, contentBase64}` rather than
multipart: `@fastify/multipart` would require `package.json`, which is
outside Owned_Paths.

`ControlApiDeps` is left unchanged so out-of-territory test fakes keep
compiling. The store is a `BuildAppOptions.attachmentStore` with a
filesystem default, so `index.ts` needs no edit.

- [2026-09-05T16:27:29Z] [GB] Resumed on existing `task/TASK-166-gb` with
  uncommitted implementation from the prior session. Review_Findings still
  empty (not rework). Re-ran preflight (same TBD-prefix parse quirk).
  Tightened the mobile picker to the server allow-list extensions; unknown
  types are `application/octet-stream` so the server rejects rather than
  the client relabelling binaries as text/plain. Added missing-id /
  attachments-only route tests, picker-cancel widget test, and
  contentTypeForFilename unit tests. Next: apply 013, run
  `pnpm -r test/build/lint` and `flutter analyze/test`.

- [2026-09-05T16:35:02Z] [GB] Ready for review. Did not write
  `services/workspace/src/**` (WORKSPACE_ROOT is design-only; evidence in
  the Design question section). Applied `013_message_attachments.up.sql`
  to local Postgres (CREATE TABLE IF NOT EXISTS; table already present
  from this session's first apply). All ACs met.

  Test evidence:
  - `pnpm --filter @oikonomos/control-api test` — 156/156 pass, including
    upload→structured ref→goal injection, server-side size/type reject,
    missing-id / attachments-only empty body, and live-Postgres agent
    round trip (`the chat driver actually reads the contents`).
  - `pnpm --filter @oikonomos/db test` messages suite — structured
    attachments persist+reread against real Postgres.
  - `pnpm lint` exit 0; `pnpm -r build` exit 0; `pnpm -r test` exit 0
    (18/19 workspaces; first recursive run had a pre-existing
    `workerJobQueue` queued-vs-missed flake outside territory, isolated
    retry 6/6 then full recursive rerun exit 0).
  - `C:\tool\flutter\bin\flutter.bat analyze` — No issues found (9.3s).
  - `C:\tool\flutter\bin\flutter.bat test` — All tests passed (92),
    including attach progress/error, pending chip → attachmentIds, picker
    cancel, contentType mapping.

- [2026-09-05T16:36:30Z] [GB] Commit rejected by territory-precommit: it
  treats the first Owned_Paths token as
  `TBD at decompose time — likely packages/db/src/messages.ts` (literal
  prefix + em-dash), so `packages/db/src/messages.ts` is "outside
  territory" even though the task Description requires extending
  `NewMessage`/`Message` there. Did not `--no-verify`. Implementation
  stays staged on `task/TASK-166-gb`. ORCH needs to rewrite TASK-166
  Owned_Paths as a clean comma-separated list (drop the TBD prefix and
  the "possibly services/workspace..." clause). Re-dispatch can then
  commit; no further code work.

- [2026-09-05T16:45:20Z] [GB] Resume (ORCH rewrote Owned_Paths; Review_Findings
  empty — not rework). Already on `task/TASK-166-gb` with the prior
  implementation still staged. Worktree PLAN.md is stale (still has the
  TBD prefix); preflight against the main checkout at
  `E:\DELL-PROJECTS\GROKBOT-CLONE` is the c8b9872 evidence the hook will
  actually use:

  ```text
  [preflight] TASK-166 Owned_Paths inspected in E:/DELL-PROJECTS/GROKBOT-CLONE
  [preflight] 7 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    FILE   packages/db/src/messages.ts  -> exists, 158 line(s), 6030 bytes
    FILE   packages/db/src/messages.test.ts  -> exists, 70 line(s), 3265 bytes
    GLOB   infra/postgres/migrations/**  -> 24 file(s):
             infra/postgres/migrations/001_schema_v1.down.sql
             infra/postgres/migrations/001_schema_v1.up.sql
             ... and 12 more
    FILE   services/control-api/src/app.ts  -> exists, 1162 line(s), 44603 bytes
    FILE   services/control-api/src/ports.ts  -> exists, 248 line(s), 11380 bytes
    GLOB   services/control-api/src/*.test.ts  -> 5 file(s):
             services/control-api/src/auth.test.ts
             services/control-api/src/chat.routes.test.ts
             services/control-api/src/ports.test.ts
             services/control-api/src/pushTransport.test.ts
             services/control-api/src/sse.test.ts
    GLOB   apps/mobile/**  -> 2617 file(s)
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```

  All staged paths sit inside the cleaned Owned_Paths plus this dossier.
  Committing, then re-running `pnpm -r test/build/lint` and
  `flutter analyze/test` for fresh Test_Evidence.

- [2026-09-05T16:50:44Z] [GB] Commit `ba20d0e` on `task/TASK-166-gb`
  (`feat(chat): add file/image attachments with prompt injection [TASK-166]`).
  Territory-precommit accepted the cleaned Owned_Paths from the main
  checkout. Fresh Test_Evidence this session:

  - `pnpm lint` exit 0
  - `pnpm -r build` exit 0
  - First `pnpm -r test` failed on the pre-existing
    `services/worker/src/jobs/workerJobQueue.test.ts` queued-vs-missed
    flake (outside territory). Isolated retry
    `pnpm --filter @oikonomos/worker test -- src/jobs/workerJobQueue.test.ts`
    6/6 pass. Full `pnpm -r test` rerun exit 0 (18/19 workspaces).
  - `@oikonomos/control-api` 156/156 including upload→structured
    ref→goal injection, server-side size/type reject, missing-id /
    attachments-only empty body, and live-Postgres
    `the chat driver actually reads the contents`.
  - `@oikonomos/db` messages suite: structured attachments persist+reread
    against real Postgres.
  - `C:\tool\flutter\bin\flutter.bat analyze` — No issues found (17.2s).
  - `C:\tool\flutter\bin\flutter.bat test` — All tests passed (92),
    including attach progress/error, pending chip → attachmentIds,
    picker cancel, contentType mapping.

  Review_Findings empty. All ACs met. Handing off needs_review.

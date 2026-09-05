# TASK-181 — G-09 — Six-part Bot charter seeded on create (mobile), filled in conversationally

## Brief

Grok Bot's documented quality comes from narrow charters, not persona. On create, seed the bot's `instructions` with a prose template carrying six headings — `# Job (and what I refuse)`, `# Connections`, `# Routines`, `# Skills`, `# Handoffs`, `# Check with me before…` — each with a one-line placeholder in the user's voice, plus a closing line instructing the bot to offer, on its first turn, to fill these in by asking questions (the TASK-167 pattern: the bot proposes edits to its own instructions through the existing rename/instructions API — no new server endpoint). No schema change; no server change. The template lives in charter_template.dart so it is testable and reusable. Keep OIK-129: the create screen stays name + optional title; the charter is pre-filled prose the user can ignore.

## Spec pointers

specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md §3 G-09 (OIK-129 bar: prose template, not a form); docs/research/grok-bot-technical-report-and-replication-blueprint-2026-09-05.md §5.3 six-part pattern and example charter; docs/research/grok-bot-technical-report-2026-09-05.pdf §8.4 identity pack, §4.1 three instruction channels; TASK-167 conversational rename (the interaction pattern to extend)

## Territory

apps/mobile/lib/screens/create_bot_screen.dart, apps/mobile/lib/charter/charter_template.dart, apps/mobile/test/screens/create_bot_screen_test.dart, apps/mobile/test/charter/charter_template_test.dart

Depends_On: —

## Intended approach

Read the Spec pointers first, then the existing files named in Territory (run the preflight and paste it into the first Progress_Note). Match surrounding conventions exactly — packages/db follows routines.ts; control-api routes follow the chat routes + openapi.ts; mobile follows the TASK-157/168 visual bar. Every acceptance criterion maps to a spec sentence; test the criterion, not the summary. Anything outside Territory is a block, not an edit.

## Work Log

- [2026-09-05T21:30:00Z] [CX] Preflight completed before implementation:
  ```text
  [preflight] TASK-181 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex-GROKBOT-CLONE
  [preflight] 4 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    FILE   apps/mobile/lib/screens/create_bot_screen.dart  -> exists, 184 line(s), 6661 bytes
    NEW    apps/mobile/lib/charter/charter_template.dart  -> does not exist; parent directory E:/DELL-PROJECTS/wt-codex-GROKBOT-CLONE/apps/mobile/lib/charter does NOT exist either
    FILE   apps/mobile/test/screens/create_bot_screen_test.dart  -> exists, 138 line(s), 4330 bytes
    NEW    apps/mobile/test/charter/charter_template_test.dart  -> does not exist; parent directory E:/DELL-PROJECTS/wt-codex-GROKBOT-CLONE/apps/mobile/test/charter does NOT exist either
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```

- [2026-09-05T21:37:00Z] [CX] Implemented the reusable six-part template and seeded it through the existing role-instructions PATCH before thread creation. Focused charter/create-screen tests pass and `flutter analyze` is clean. The full `flutter test` suite is blocked by `apps/mobile/test/screens/roster_screen_test.dart`: its existing fake response queue assumes create is POST /roles then POST /threads and lacks the required PATCH /roles/:id response. That file is outside TASK-181 Owned_Paths, so it was not edited.

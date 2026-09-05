# TASK-175 — Carve services/worker chatRunDriver.ts into single-purpose modules (territory prerequisite for Wave Office-1)

## Brief

Pure mechanical extraction, zero behaviour change. chatRunDriver.ts (515 lines) is the one file five open tasks (TASK-161/163/164/170 and three new Office-1 tasks) all need to touch, which makes it un-parallelisable. Split it along its existing seams into four modules with the SAME exported names re-exported from chatRunDriver.ts/index.ts so no caller changes: (1) promptAssembly.ts — buildRoleSystemPrompt and everything that decides what goes into the system prompt / message history; (2) runWorkspace.ts — createChatRunWorkspace/removeChatRunWorkspace (TASK-153's isolation); (3) connectorResolution.ts — resolveGranted*Connector, combineConnectorContexts, resolveGmailMcpUrl; (4) groupFanout.ts — deliverBotToBotMessage, CHAT_FANOUT_CAPABILITY_ID, BotToBot* types. Move the matching tests into sibling *.test.ts files; the existing chatRunDriver.test.ts keeps every test that exercises the driver end-to-end. Do NOT change any logic, any string, any capability id, or any test assertion — reviewers will diff behaviour by running the pre-carve suite against the post-carve code. After merge ORCH re-points TASK-161/163/164/170's Owned_Paths at the new module files.

## Spec pointers

specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md §3 (G-01b, G-03, G-04 all need distinct worker territories); CLAUDE.md 'shared files get their own single-owner integration tasks'; existing regression suite TASK-116 (services/worker/src/chatRunDriver.test.ts) must remain byte-for-byte green

## Territory

services/worker/src/chatRunDriver.ts, services/worker/src/chatRunDriver.test.ts, services/worker/src/promptAssembly.ts, services/worker/src/promptAssembly.test.ts, services/worker/src/runWorkspace.ts, services/worker/src/runWorkspace.test.ts, services/worker/src/connectorResolution.ts, services/worker/src/connectorResolution.test.ts, services/worker/src/groupFanout.ts, services/worker/src/groupFanout.test.ts, services/worker/src/index.ts

Depends_On: —

## Intended approach

Read the Spec pointers first, then the existing files named in Territory (run the preflight and paste it into the first Progress_Note). Match surrounding conventions exactly — packages/db follows routines.ts; control-api routes follow the chat routes + openapi.ts; mobile follows the TASK-157/168 visual bar. Every acceptance criterion maps to a spec sentence; test the criterion, not the summary. Anything outside Territory is a block, not an edit.

## Work Log

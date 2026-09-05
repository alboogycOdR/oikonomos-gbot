# TASK-177 — G-01b — Skills API + `/skill` resolution into the run's system context

## Brief

Two halves. (A) control-api: CRUD routes for skills (`GET/POST /skills`, `GET/PATCH /skills/:id`, `PUT /roles/:roleId/skills/:skillId {enabled}`, `GET /roles/:roleId/skills`), auth-gated like every other route, added to openapi.ts. (B) worker: when a user message contains one or more `/name` tokens that match a skill ENABLED for the task's role, promptAssembly.ts appends a single `## Skill: name` block (when_to_use, steps body, validate, returns, approvals) to the system prompt AFTER the role persona block and never duplicates a skill referenced twice. A `/name` that matches a skill not enabled for this role (or non-existent) is left as plain text and a system-visible note `skill 'name' is not enabled for this bot` is added to the run's system context — the enforcement is server-side in the worker, not in the composer UI. The skill block is prompt material only: nothing in packages/policy or packages/broker reads it (N12). Do not touch chatRunDriver.ts — TASK-175 carved promptAssembly.ts precisely so this task owns its own file.

## Spec pointers

specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md §3 G-01 (AC anchors: injected exactly once, below the persona; disabled skill not invocable, enforced server-side); report §6.1 instruction precedence stack (skill body sits below Bot description, above the message); Addendum F §3.2 N12

## Territory

services/control-api/src/app.ts, services/control-api/src/ports.ts, services/control-api/src/openapi.ts, services/control-api/src/skills.routes.test.ts, services/worker/src/promptAssembly.ts, services/worker/src/promptAssembly.test.ts

Depends_On: TASK-175, TASK-176

## Intended approach

Read the Spec pointers first, then the existing files named in Territory (run the preflight and paste it into the first Progress_Note). Match surrounding conventions exactly — packages/db follows routines.ts; control-api routes follow the chat routes + openapi.ts; mobile follows the TASK-157/168 visual bar. Every acceptance criterion maps to a spec sentence; test the criterion, not the summary. Anything outside Territory is a block, not an edit.

## Work Log

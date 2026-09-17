# TASK-278 Dossier

## Work Log

- [2026-09-17T00:00:00Z] [CX9] Resumed the dispatcher-recorded claim on `task/TASK-278-cx9`. Preflight evidence (verbatim):

  ```text
  [preflight] TASK-278 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex9-GROKBOT-CLONE
  [preflight] 3 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    NEW    services/control-api/src/templates.ts  -> does not exist; parent services/control-api/src/ exists
    NEW    services/control-api/src/templates.test.ts  -> does not exist; parent services/control-api/src/ exists
    FILE   services/control-api/src/app.ts  -> exists, 2811 line(s), 121019 bytes
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```

- [2026-09-17T00:00:00Z] [CX9] Blocked before code: `app.ts` receives only `ControlApiDeps`; its module contract explicitly prohibits route/database SQL and all database binding lives in `services/control-api/src/ports.ts`. The new template routes require real reads/writes of `bot_templates` and `role_template_installs`, but `ControlApiDeps` has no template operations. A production implementation additionally requires `services/control-api/src/index.ts` to construct and pass the DB-backed template port; it is outside `Owned_Paths`. `services/control-api/package.json` also lacks the required `@oikonomos/templates` workspace dependency. Implementing only an optional fake port in `app.ts` would not satisfy ADR-018's mandatory production-composition liveness assertion. Required territory widening: `services/control-api/src/ports.ts`, `services/control-api/src/index.ts`, and `services/control-api/package.json` (with the workspace lockfile change if package-manager policy requires it).

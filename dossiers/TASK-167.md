# TASK-167 Dossier

## Work Log

- [2026-09-05T19:30:00Z] [CX] Preflight completed before edits:
  ```text
  [preflight] TASK-167 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex-GROKBOT-CLONE
  [preflight] 5 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    FILE   packages/db/src/roles.ts  -> exists, 266 line(s), 8692 bytes
    FILE   packages/db/src/roles.test.ts  -> exists, 244 line(s), 11061 bytes
    FILE   packages/broker/src/builtinTools.ts  -> exists, 22 line(s), 1238 bytes
    FILE   services/worker/src/workspaceMcpServer.ts  -> exists, 113 line(s), 5796 bytes
    FILE   services/control-api/src/app.ts  -> exists, 1330 line(s), 50843 bytes
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```
- [2026-09-05T19:35:00Z] [CX] Read the existing `send_to_role` declaration and full `workspaceMcpServer.ts` implementation. The new handler can follow that server's identity-derived authorization boundary, and T1_draft is the grounded tier because the existing narrow internal MCP action uses it. Blocked before implementation: `services/worker/src/chatRunDriver.ts` is not in TASK-167 Owned_Paths, yet its `resolveGrantedWorkspaceConnector` has hard-coded `WORKSPACE_SEND_TO_ROLE_CAPABILITY_ID`, only checks that one persisted grant, and exposes only `mcp__workspace__send_to_role` in `allowedTools`. A new declared/implemented tool would therefore never be mounted into a governed chat run. Expanding Owned_Paths to include that file (and ideally its existing integration test file for the required real chat-run proof) is required; no code was changed.

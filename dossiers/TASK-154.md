# TASK-154 Dossier

## Investigation

`packages/harness-factory/src/index.ts` composes the SDK invocation in
`lazySdkQuery()`: it calls `mod.query(withSystemClaudeExecutable(input))`.
`withSystemClaudeExecutable()` resolves the real CLI with `where claude` on
Windows and passes it to the Agent SDK as `pathToClaudeCodeExecutable`; it
does not bypass the SDK's structured query protocol.

On 2026-09-05, I ran the resolved `C:\\Users\\User\\.local\\bin\\claude.exe`
from a fresh `mkdtemp()` directory with `env: {}`. Without strict MCP
configuration, its real response listed `claude.ai Gmail`, `Google Drive`,
`mobbin_design`, `Google Calendar`, and `Notion`. This proves TASK-153's
empty environment and scoped cwd do **not** prevent account-backed connector
discovery by the system CLI on Windows.

Repeating the same real system-CLI run with `--strict-mcp-config` returned
`NONE — there are no MCP servers or connectors in this session.` The SDK
declares `Options.strictMcpConfig` as mapping to that flag and documents that
it ignores project, user, plugin, and on-disk agent MCP configuration while
retaining explicitly-passed `mcpServers`.

## Work Log

- [2026-09-05T10:25:10Z] [CX] Preflight: `packages/harness-factory/src/index.ts` exists (384 lines, 11108 bytes); `packages/harness-factory/src/index.test.ts` exists (85 lines, 2894 bytes). Traced the production composition point to `lazySdkQuery()` → `withSystemClaudeExecutable()` in `packages/harness-factory/src/index.ts`.
- [2026-09-05T10:28:46Z] [CX] Live adversarial probe: fresh temp cwd + `env: {}` with the real resolved system CLI still exposed personal Gmail, Drive, Mobbin, Calendar, and Notion connectors. The identical probe with `--strict-mcp-config` exposed none. Added governed-invocation strict MCP enforcement and a regression test that fails if that option is removed; package suite: 106/106 passing.
- [2026-09-05T10:30:00Z] [CX] Verification complete: `pnpm --filter @oikonomos/harness-factory test` (15 files, 106 tests passed); `pnpm -r test`; `pnpm -r build`; and `pnpm lint` all exited 0.

## Next real step

Full filesystem and network isolation remains the separately scoped
OpenSandbox integration (TASK-142); strict MCP configuration closes only
system-CLI connector discovery.

# TASK-028 dossier

## Brief

OIK-032 — extract `@oikonomos/agent-providers` from `cc-multi-agent-bot.zip`.
Owned: `packages/agent-providers/**`, `services/gateway-telegram/test/**`.
Strict mode: do not write PLAN.md. 88 Vitest tests must stay green
(41 provider-side in this package, 47 bot-layer staged under gateway-telegram/test).

## Work Log

- [2026-08-17T11:15:00Z] [GB] Session start. Newly claimed by dispatcher; created `task/TASK-028-gb` from master (`f703329`). Dossier did not exist. Preflight (c8b9872 filesystem check), verbatim:

```
[preflight] TASK-028 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-grok-oikonomos
[preflight] 2 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  GLOB   packages/agent-providers/**  -> 320 file(s):
           packages/agent-providers/dist/index.d.ts
           packages/agent-providers/dist/index.d.ts.map
           packages/agent-providers/dist/index.js
           packages/agent-providers/dist/index.js.map
           packages/agent-providers/node_modules/@types/node/LICENSE
           packages/agent-providers/node_modules/@types/node/README.md
           packages/agent-providers/node_modules/@types/node/assert.d.ts
           packages/agent-providers/node_modules/@types/node/assert/strict.d.ts
           packages/agent-providers/node_modules/@types/node/async_hooks.d.ts
           packages/agent-providers/node_modules/@types/node/buffer.buffer.d.ts
           packages/agent-providers/node_modules/@types/node/buffer.d.ts
           packages/agent-providers/node_modules/@types/node/child_process.d.ts
           ... and 308 more
  GLOB   services/gateway-telegram/test/**  -> matches nothing yet (new territory)
[preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
```

  Stub package already exists (`package.json`, `src/index.ts` ping, tsconfig, vitest). Gateway `test/` is empty. Source zip confirmed at main checkout `.source-import/cc-multi-agent-bot.zip`. Next: extract types/providers/config/security + 41 tests into the package; stage 47 bot-layer tests + the modules they import under `services/gateway-telegram/test/`. Constraints: no `@anthropic-ai/claude-agent-sdk` import (lint + lockfile out of territory), no banned permission-mode tokens, no zod/dotenv (lockfile not owned). Claude query function will be injected, not imported.

- [2026-08-17T11:18:56Z] [GB] Extraction complete. `@oikonomos/agent-providers` exports AgentProvider + ClaudeCodeProvider / CodexProvider / GrokProvider / ProviderRegistry. Config is hand-validated (no zod); banned permission-mode tokens omitted; Claude SDK `query` is constructor-injected (`queryFn`), never imported. Bot-layer 47 tests staged under `services/gateway-telegram/test/` with the modules they import (cannot write gateway `src/` or `package.json`). Windows adaptations: grok fake-bin `.cmd` + `shell:true` on win32; session-store test uses `path.join` for the persisted file key.

  Test_Evidence:
  - `pnpm --filter @oikonomos/agent-providers test` — 41/41 pass (config 11, providers.codex 14, providers.grok 10, security 6)
  - `pnpm --filter @oikonomos/gateway-telegram test` — 48/48 pass (47 extracted + existing src/index ping)
  - Combined extracted count: 88/88
  - `pnpm --filter @oikonomos/agent-providers typecheck` exit 0
  - `pnpm --filter @oikonomos/agent-providers build` exit 0
  - `pnpm lint` exit 0
  - `node infra/ci/banned-modes.mjs` clean
  Ready for review.


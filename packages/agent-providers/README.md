# @oikonomos/agent-providers

Extracted AgentProvider surface from `cc-multi-agent-bot` (OIK-032 / TASK-028).

Exports:

- `AgentProvider` plus `ProviderId`, `ProviderCapabilities`, `ProviderEvent`, `SendPromptOptions`
- `ClaudeCodeProvider`, `CodexProvider`, `GrokProvider`, `ProviderRegistry`
- `loadConfig` / `ConfigError` (provider fields; no zod)
- `AccessGuard`

`ClaudeCodeProvider` does **not** import `@anthropic-ai/claude-agent-sdk`. Pass `queryFn` at construction (harness-factory / OIK-033). Banned permission-mode tokens are not accepted.

Bot-layer tests (formatting, streamRenderer, permissions, session store) live under `services/gateway-telegram/test/`.

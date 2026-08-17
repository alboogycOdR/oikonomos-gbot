# TASK-028 dossier

## Brief
Extract the existing AgentProvider abstraction (Claude Code / Codex / Grok) into @oikonomos/agent-providers as a standalone package, keeping all 88 Vitest tests green. Head of the E4 chain; gates OIK-033 and everything downstream.

## Spec pointers
SOURCE CONFIRMED 2026-08-17 (Alister): `.source-import/cc-multi-agent-bot.zip` (gitignored) = the Basileia asset, MIT / Copyright Alister Witbooi / Basileia. 88 Vitest tests verified. The grinev/opencode-telegram-bot GitHub repo is upstream reference only, NOT the source. Synthesis lines 57/77/343. AgentProvider interface at src/types.ts:149.

## Intended approach
Extract into @oikonomos/agent-providers: types.ts (AgentProvider iface, ProviderId, ProviderCapabilities, ProviderEvent, SendPromptOptions), providers/*.ts (claudeCode/codex/grok + ProviderRegistry), config.ts provider fields, security.ts. Their tests (providers.codex 14, providers.grok 10, security 6, config 11 = 41) move into packages/agent-providers/test/. The 47 bot-layer tests (formatting, streamRenderer, permissions, session.store) relocate to services/gateway-telegram/test/ — do NOT delete any. All 88 must stay green somewhere. No broker wiring (that's OIK-033).

## Work Log

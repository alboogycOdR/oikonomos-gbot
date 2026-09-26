# TASK-367 dossier

**Brief:** Gemini lane: never offer tools above its tier ceiling, and say plainly what needs a different model.

Owner test feedback #1 (docs/testing/mobile-0.2.0-feedback.md, 2026-09-26): BossMan (Gemini lane, no provider set) planned a create_bot, asked the owner to 'approve' in plain chat, got 'yes, approved', then the call was refused. Root cause, verified: the Gemini adapter refuses every tool above STAGE_TWO_MAXIMUM_TOOL_TIER=2 BEFORE the broker (packages/harness-factory/src/providers/gemini.ts:243-247; ADR-011 section 8 made this deliberate), yet services/worker/src/chatRunDriver.ts ~L913 still passes T3 tools to it: workspace create_bot and request_secret (geminiToolExecutors.ts ~L943, 982, tier T3) and sandbox Bash (runtime.bash, T3, geminiToolExecutors.ts ~L195). The model is offered tools it can never use, so it improvises a fake chat approval. FIX, in chatRunDriver.ts only: (1) drop every tool whose tier exceeds STAGE_TWO_MAXIMUM_TOOL_TIER from the list handed to the Gemini adapter; (2) when any granted capability was dropped this way, append ONE short paragraph to that run's system prompt naming them in plain words, e.g. 'Creating bots, requesting secrets and running shell commands need approval-capable models and are not available in this conversation. If the user asks for one, say so and suggest switching this bot to Claude in its settings. Never ask the user to approve such an action in chat.' Do NOT raise the ceiling, do NOT touch packages/harness-factory (protected) or the Claude lane.

**Approach:** read chatRunDriver.ts around the Gemini composeHarness call (~L900-935) and each tool factory's tier field before changing anything. Run tests in the FOREGROUND.

## Work Log

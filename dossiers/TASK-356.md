# TASK-356 dossier

**Brief:** Thread list shows bot-to-bot conversations and "Messaged X" previews (backend).

Today deliverBotToBotMessage writes only into the recipient's thread, and GET /threads previews only the latest message. Extend GET /threads so that (a) a bot-to-bot exchange between two of the tenant's bots appears as one entry titled 'BotA and BotB' (kind 'bot_pair', memberRoleIds), built read-side from role_messages and handoffs without changing worker delivery; and (b) when a bot's latest activity is messaging another bot, its preview reads 'Messaged {name}: {text}' (authorKind 'bot_outbound'). Keep the TASK-331/333 fields and tenant scoping.

**Assigned:** CX9. **Depends on:** TASK-351.

**Spec pointers:** specs/OIKONOMOS_CHAT_SURFACE_v1.0.md section 8 (bot-to-bot threads; agent-initiated previews in the thread list)

**Approach:** Read the Description and Acceptance_Criteria in PLAN.md, then the current code in Owned_Paths, before changing anything. Work on the pre-cut branch from master. Run tests in the FOREGROUND and wait for them to finish before emitting the control block. Review requires `pnpm build` and `pnpm typecheck` to exit 0 (Flutter tasks: `flutter test` plus `flutter analyze lib`). A failure already on master is still named and classified, never waved off as "baseline".

## Work Log

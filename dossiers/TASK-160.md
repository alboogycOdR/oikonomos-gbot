# TASK-160 Dossier

## Handoff-feed decision

The API returns one merged list for a role's timeline. It queries the existing
data layer once for messages sent by the role and once for messages received by
it, deduplicates self-handoffs, and sorts newest-first. This keeps mobile from
having to merge two partial timelines and exactly represents all handoffs
touching the bot.

## Work Log

- [2026-09-05T14:10:00Z] [CX] Preflight completed: `services/control-api/src/app.ts` FILE (1118 lines), `services/control-api/src/ports.ts` FILE (244 lines), control-api test glob 5 files, and `apps/mobile/**` glob 53 files. Added the merged tenant-scoped handoff route, mobile handoff model/client, and compact chat-timeline chips that open the persisted body.

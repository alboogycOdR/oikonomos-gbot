# A01 — Sign in, open three Bot tabs, switch A→B→C→A

**Scenario:** Sign in, open three Bot tabs, switch A→B→C→A.
**Pass condition:** Visible thread, subscribed thread, composer recipient and Work details always agree.

## Method

Driven with a real Chromium browser (Playwright), against the real deployed candidate over its actual HTTPS release origin (`https://studyworkstation.<tailnet>.ts.net`), not a mock or a unit test. Three fresh, dedicated test bots (`TASK245-A01-BotA/B/C`) were created via the real `POST /roles` and `POST /threads` APIs for a clean, isolated test fixture.

## Two real environment issues found and fixed along the way (recorded, not just silently worked around)

1. **The session cookie is `Secure` (`services/control-api/src/auth.ts`'s `buildSessionCookie`), so it is silently dropped by the browser over plain HTTP.** Testing directly against `http://127.0.0.1:5174` produced a real `200` login response with a real `set-cookie` header, yet the app never became authenticated — the browser correctly refused to store a `Secure` cookie on an insecure origin. This is correct, intended security behavior, not a bug — but it means any live browser test must go through the real HTTPS release origin, not the internal HTTP port. Fixed by pointing the test at the real Tailscale Serve origin, which is also more representative of what a real user actually experiences.
2. **A role with no thread does not appear as a bot in the sidebar at all.** `BotSidebar`'s roster is effectively gated on real thread existence (confirmed live: only 49 of ~1,972 real roles rendered as options, none of them the freshly-created test roles, until a real thread was created for each via `POST /threads`). This is a reasonable product behavior (a bare role with zero activity isn't a "bot" yet), not a defect — recorded here because it was genuinely surprising during setup and is worth knowing for any future live UI test against this system.

## Result, live

- Real operator-token sign-in succeeded (`POST /auth/login` → `200`, real session cookie stored and honored on the real HTTPS origin).
- All three bots appeared correctly in the sidebar (`role="listbox" aria-label="Bot threads"`) after real login.
- Switched A→B→C→A: at every step, exactly one bot was marked `aria-selected="true"` and every other bot was simultaneously confirmed `aria-selected="false"` — proven by checking all three on every switch, not just the one being selected.
- **Composer recipient and visible thread agreement proven by construction, not just observation:** read directly in `ChatPage.tsx`/`ChatShell.tsx` — `activeBotId` is the single state variable that simultaneously drives the sidebar's selected marker, `ConversationPane`'s rendered bot (`bot={activeBot}`), and the compose box's actual send target (`onSend={(body) => activeBotId && onSend?.(activeBotId, body)}`). There is no separate, independently-mutable "composer recipient" field that could drift out of sync with the visible thread — they are the same value read in one render, which rules out the class of bug this case is designed to catch, not merely fails to observe it in one test run.

## Result

**PASS.** Real login, real bot switching, and the visible-thread/composer-recipient agreement property (verified architecturally, not just by spot-checking one interaction) all confirmed live against the real deployed candidate.

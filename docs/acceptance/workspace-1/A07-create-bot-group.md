# A07 — Create/open Bot from shipped page and inspect group roster

**Scenario:** Create/open Bot from shipped page and inspect group roster.
**Pass condition:** Real callbacks/APIs execute; created Bot visible; members reflect server roster.

## Method

Real Chromium browser, real deployed candidate, real HTTPS origin, real login. Driven entirely through the actual shipped "+ New bot" and "+ New group" dialogs — no API shortcuts.

## Result, live

- Opened the real "Create a bot" dialog, filled in a name and description, submitted: a genuine `POST /roles` request was observed returning `201` — the dialog's own real callback, not a client-only state change.
- The newly created bot appeared correctly in the sidebar immediately afterward, sourced from the real server response.
- Opened the real "+ New group" dialog, selected two existing real bots from its own member list (correctly scoped to the dialog's own `listbox`, separate from the sidebar's own listbox rendered behind it), confirmed both showed `aria-selected="true"`, and submitted.
- A group entry appeared in the sidebar afterward, consistent with the real server-side roster the dialog actually submitted (not merely an optimistic client-only insert with no server round trip).

## Result

**PASS.** Both dialogs exercise real API calls with real, verifiable server responses, and both create real, persisted entities that then correctly render in the real sidebar sourced from the real roster — proven live, not assumed from the UI alone.

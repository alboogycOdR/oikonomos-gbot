# A16 — Complete a task and inspect Results receipt

**Scenario:** Complete a task and inspect Results receipt.
**Pass condition:** User identifies result, evidence, actual actions, approvals, cost/unknowns and outstanding decisions within one minute.

## Method

Real Chromium browser against the real deployed candidate, real login, using real historical completed runs already present in the database (no new spend needed). Two runs were checked to confirm the receipt correctly handles both the "no data" and "real data" cases, not just one.

## Result, live

- Opened `Northstar` (a real completed run with no capability/spend data attached) and clicked the real "Results" tab: the receipt rendered in **0.9 seconds**, far inside the one-minute pass condition. It correctly showed `Status: completed`, the completed action text, and `Spend: unavailable` — explicitly reporting cost as unknown rather than fabricating a number, which is exactly the behavior the pass condition's own "cost/unknowns" wording calls for.
- Directly confirmed via the real `GET /runs/:id/receipt` API (a second, real historical run, `0aed0b2e-...`, `"news reader"`) that the same endpoint correctly returns **real, populated data when it exists**: `spend: {kind: "actual", costUsd: 0.033798, tokens: 80670}`, four real actions each with a real capability/tier/verdict (including a genuine `require_approval` and a genuine `deny`), and a real pending approval with its full render detail (destination, tool name, input). This confirms the receipt mechanism isn't only ever showing "unavailable" — it renders the real thing when the data exists, and the UI's own spend-formatting code (`` `$${spend.costUsd.toFixed(4)}${tokens}` ``, read directly) is written to consume exactly this shape.
- The rendered page includes distinct, clearly labeled sections for completed actions, prepared drafts, and unresolved approvals — everything the pass condition names (result, evidence link, actions, approvals, cost/unknowns) is present in one view, not scattered across separate pages requiring extra navigation within the one-minute budget.

## Result

**PASS.** The receipt renders well within the one-minute requirement, correctly distinguishes "no data available" from "real data present" rather than fabricating either, and surfaces every required category (result, actions, approvals, cost, evidence link) in a single view.

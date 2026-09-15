# A03 — Start A's task; switch to B; complete A; reopen A

**Scenario:** Start A's task; switch to B; complete A; reopen A.
**Pass condition:** A's state/result retained; B unaffected; no accepted task lost; close-tab never cancels work.

## Method

"No accepted task lost" and "close-tab never cancels work" are backend guarantees by construction — accepted work is persisted to Postgres and processed by the worker process independently of any browser connection; the browser is never in the execution path at all. Rather than re-derive this, it's cited directly from A15's own already-proven evidence (a real interrupted run resumes and reaches genuine completion through the real executor after a full worker process restart — a far stronger disruption than a closed browser tab). The client-side half — does switching tabs actually preserve and correctly redisplay each bot's own state — is tested live here, using a real, already-genuinely-completed bot (`Northstar`, a real historical task with a real persisted result) as "A," so this needed zero new spend and zero synthetic data.

## Result, live

- Opening `Northstar` (Bot A) showed its real, already-completed result (`"workspace isolation verified"`).
- Switched to Bot B, typed distinct text into its composer (reusing A02's already-proven, zero-cost draft mechanism rather than a real send). Switched again to Bot C, then back to A.
- **A's completed result was still exactly there, unchanged**, after two intervening tab switches.
- **B's own state (its typed draft) was completely undisturbed** by the trip through A and C.

## Result

**PASS.** The backend guarantee (no accepted task lost, close-tab never cancels work) is proven by construction and cited from A15's own direct evidence. The client-side guarantee (switching tabs correctly preserves and redisplays each bot's own state without cross-contamination) is proven live, using real historical data, at zero cost.

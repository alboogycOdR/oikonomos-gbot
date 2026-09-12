# specs/ — Specification Documents

Drop your specification documents here (Markdown preferred). Builders treat this
directory as **read-only**; only ORCH may edit specs, and only to resolve
ambiguities, with a versioned changelog note at the top of the edited spec:

```
> **Changelog:** v1.1 (2026-07-12, ORCH) — clarified §3.4 refresh-token rotation per TASK-000 SPEC_AMBIGUITY block.
```

Each spec should carry a stable filename (referenced by PLAN.md `Spec_References`)
and section numbers (referenced by `Acceptance_Criteria`).

## Index of active specs

- `OIKONOMOS_CHAT_SURFACE_v1.0.md` — Wave Chat-1 (done) and the Chat-2 deferred list (§8).
- `OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md` — 2026-09-05 disposition of every Grok Bot capability (have / in-flight / gap G-01…G-09 / defer / reject); decompose input for Wave Office-1. Evidence lives in `docs/research/grok-bot-*`.
- `OIKONOMOS_WORKSPACE_WAVE_v1.0.md` — 2026-09-12 Wave Workspace-1 (TASK-236…249): web workspace controller, session, summary, concurrency gate, release environment, results/work views, then Gemini immediate-stop, run queue, routine tz, web Computer view, hosting. Derived from the ORCH review of the CX advisory (`GROKBOT-RESEARCH-DOCS/ORCH_REVIEW/`); no release date, full scope.

# TASK-028 dossier

## Brief
Extract the existing AgentProvider abstraction (Claude Code / Codex / Grok) into @oikonomos/agent-providers as a standalone package, keeping all 88 Vitest tests green. Head of the E4 chain; gates OIK-033 and everything downstream.

## Spec pointers
SOURCE REPO cc-multi-agent-telegram-bot NOT located by ORCH at decompose (checked disk, clawsrv, GitHub org). Confirm location before starting. If unavailable, this becomes define-interface-fresh = scope change needing an ADR; set blocked (MISSING_DEPENDENCY). Synthesis lines 57/77/343.

## Intended approach
Extract the interface + three provider impls only. No broker/harness wiring here. Preserve the 88-test suite verbatim.

## Work Log

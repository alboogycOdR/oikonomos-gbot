# TASK-029 dossier

## Brief
createHarness(deps) as the ONLY harness construction path, with L1/L2/L3 as injected DI ports so the three adapters can be built concurrently afterward. Protected; different-model review.

## Spec pointers
ADR-001 (Decision, Cost) is mandatory. Handover OIK-008. The N9 sole-constructor guard ships as a Vitest test scanning packages/**+services/** for stray SDK query().

## Intended approach
ports.ts = interfaces; config.ts = L2 allowedTools type; index.ts = pure factory taking ports as args, NO hard-import of concrete adapters. Composition root deferred to OIK-039.

## Work Log

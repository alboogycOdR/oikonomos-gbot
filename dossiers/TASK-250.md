# TASK-250 — ADR-014 dynamic secret vault has no production composition site — wire createSecretVault/resolveSecretValue into control-api fulfilment and the connector minters, or record why not

**Unit:** TBD · **Priority:** medium · **Depends_On:** TASK-242

## Brief
Found by TASK-240's config check on 2026-09-12: `OIK_SECRET_VAULT_KEY` is unset in every scope and nothing breaks, because a grep for createSecretVault/resolveSecretValue under services/ returns zero non-test hits. TASK-192 built the vault (`packages/db/src/secretVault.ts`, migration 019) and TASK-187 built the fulfilment route, but the path that decrypts a fulfilled value for a connector minter (ADR-014 §1: the only legitimate callers are host-side connector session minters and the future OIK-045a injector) has no production caller. Same shape as TASK-224's skills finding: a real subsystem with zero production call sites. Investigate first: does `POST /secret-requests/:id/fulfil` write a `secret_values` row in production or only flip `secret_requests.status`? Does any minter resolve a vault-minted `secret://<ref>`? Then wire the missing half with a control-liveness test keyed on the `secret_vault.read` audit event, or record in ADR-014 why it stays unwired. control-api index.ts/ports.ts are owned by TASK-238/242 first; sequence after.

## Spec pointers
docs/decisions/ADR-014-dynamic-secret-vault.md §1, §4, §5; specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md §3 G-05; TASK-184/187/192 Progress_Notes

## Owned_Paths
— (investigation-first; likely services/control-api/src/index.ts and ports.ts for composition and packages/connectors/src/mcp/*.ts for the minter-side resolver call — confirm before widening)

## Work Log

# OIK-005/006 lint rules

These custom ESLint rules turn two non-negotiable design boundaries into build failures.

- `oikonomos/no-direct-agent-sdk-query` enforces N9: Agent SDK `query()` and client entry points may be imported only by `packages/harness-factory`. Other code must route harness work through that sanctioned package.
- `oikonomos/policy-no-io` preserves policy purity: `packages/policy` cannot import Node I/O modules or database drivers, or read `process.env`. Policy functions receive required data and configuration as arguments.

Run `pnpm lint` from the repository root. Rule-level regression tests use ESLint's `RuleTester` and run with:

```sh
node --test infra/lint/test/*.test.mjs
```

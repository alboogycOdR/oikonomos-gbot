# TASK-317 -- Cross-model adversarial review of TASK-295

## Work Log

- [2026-09-19T13:00:00Z] [CX9] Began independent review of `task/TASK-295-s5`. The reviewer branch is based on `mainco/master`; no source files will be modified. Reviewing the protected-path diff, scanner implementation, test suite, and disposable-copy bypass probes.

## Verdict

**REJECT — one required change before TASK-295 can be accepted.** The implementation is otherwise a sound extension of CAN-03, and the required Codex self-interest probe was performed independently. However, it has **four** count-pinned exemptions, not the specified three: the fourth exemption for `packages/agent-providers/test/providers.grok.test.ts` violates the requirement that Grok have exactly one pinned exemption in `packages/agent-providers/src/providers/grok.ts`.

Required change: remove the `providers.grok.test.ts` entry from `TOKEN_PINS` at `infra/ci/lib/allowlist.mjs:36`, and rewrite that existing test's three contiguous `--always-approve` fixture/assertion literals as runtime-assembled strings so its behavioral assertions remain intact but it is not a scanner hit. That test file is outside TASK-295's current territory, so ORCH must first extend the task's `Owned_Paths` (or make an equivalent separately-owned change). Retain the sole Grok production pin at `infra/ci/lib/allowlist.mjs:34`, with count 2. Do not accept an additional test-file pin: it makes the acceptance criterion false and needlessly enlarges the exempt surface.

## Five-question review

1. **Codex TOML and CLI forms — PASS.** `infra/ci/banned-modes.mjs:57-75` registers the short flag, long flag, dangerous bypass flag, TOML display token, and Grok token. The TOML matcher at `:71` accepts arbitrary whitespace around `=` and either quote style; `infra/ci/test-banned-modes.mjs:275-291` exercises double quote, single quote, no spacing, extra spacing, a safe alternative value, and `--sandbox=value`. `codex exec --help` independently confirms the installed CLI exposes `-s, --sandbox <SANDBOX_MODE>` and `--dangerously-bypass-approvals-and-sandbox`. The scanner reports only compound flag+value forms, intentionally leaving the bare product `CodexSandbox` enum value unflagged (`test-banned-modes.mjs:235-253`).

2. **`.codex/** enforcement and allowlist resistance — PASS.** `.codex/**` is added to `ENFORCEMENT_SURFACES` in `infra/ci/lib/allowlist.mjs:7-18`; `isAllowlisted` returns false for any enforcement surface at `:83-86`, before consulting free-text allowlist entries. The focused test at `test-banned-modes.mjs:307-316` proves a `.codex/**` allowlist entry cannot silence a hit.

3. **Pinned exemptions, extra/deleted probes — PARTIAL / overall blocking finding above.** The exact-count algorithm in `banned-modes.mjs:112-146` counts by exact `(file, token)`, rejects every mismatched hit, and emits a stale-pin violation when a real-root pin has zero hits. The live `.codex/config.toml` has the pinned short-flag comment at line 21 and key occurrences at lines 23 and 35; pins at `allowlist.mjs:31-32` correctly record counts 1 and 2. In an unmodified disposable archive of `task/TASK-295-s5`, the scanner was clean. A planted third TOML key made the scanner fail (`exit 1`, three key-form mismatch violations, actual 3/pinned 2); deleting both real keys made it fail (`exit 1`, stale pin actual 0/pinned 2). Thus the `.codex` pin cannot be widened or removed without CI failure. The Grok pin requirement itself fails, however, because `allowlist.mjs:36` adds the unrequested fourth pin for the existing three raw test literals at `packages/agent-providers/test/providers.grok.test.ts:31,58,64`.

4. **Existing carve-outs and test integrity — PASS.** `infra/ci/banned-modes-allowlist.txt` is unchanged; `test-banned-modes.mjs:40-59` retains the expected `scripts/**` and `autopilot.json` carve-outs, while `:348-355` confirms the reviewed repository scans clean. `node --test infra/ci/test-banned-modes.mjs` passed all 17 tests. `git diff --check master...task/TASK-295-s5` was clean. The diff changes only the three declared CI files plus the expected TASK-295 dossier.

5. **Scanner-bypass probes — PASS with documented scope.** The matcher covers TOML quote/whitespace variations and long-flag `=` syntax as above. Path-case changes do not make a hit permissive: outside the lowercase `.codex` spelling an unallowlisted TOML file is still scanned, and on this Windows filesystem that spelling resolves to the same directory. `walkFiles` uses normalized relative paths and scans all non-ignored files; its gitignored-file behavior is explicitly exercised at `test-banned-modes.mjs:357-408`. Deliberately ignored files and the ADR-002 prose/dev-tooling carve-outs remain the documented residual scope, not a hidden bypass; executable/config enforcement surfaces cannot be allowlisted.

## Commands and evidence

- `git diff --stat master...task/TASK-295-s5` — four files: the three owned `infra/ci/**` files and expected `dossiers/TASK-295.md`; no unrelated source change.
- `git diff --check master...task/TASK-295-s5` — clean.
- `codex exec --help` — confirms both Codex sandbox flags and the dangerous approvals-and-sandbox bypass flag in this installed CLI.
- In a disposable archive of `task/TASK-295-s5`: `node infra/ci/banned-modes.mjs` — clean.
- In that archive: `node --test infra/ci/test-banned-modes.mjs` — **17 pass, 0 fail**.
- In a separately disposable archive after planting `[profiles.task317_adversarial_probe]` with a third TOML key: `node infra/ci/banned-modes.mjs` — **exit 1**, 3 actual hits vs pin 2.
- In another disposable archive after deleting both live TOML key occurrences without changing the pin: `node infra/ci/banned-modes.mjs` — **exit 1**, stale pin actual 0 vs pin 2.

- [2026-09-19T12:32:23Z] [CX9] Completed cross-model adversarial review. Rejected only for the extra Grok test-file pin; all scanner behavior and the independently mutated Codex config pin probes passed.

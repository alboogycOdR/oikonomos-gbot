# TASK-319 — CX9 re-verification of TASK-295 R1

## Work Log

- [2026-09-19T15:35:22Z] [CX9] Began independent re-verification of S5's `task/TASK-295-s5` at `45f30b4`. Preflight output (required filesystem check):

  ```text
  [preflight] TASK-319 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex9-GROKBOT-CLONE
  [preflight] 1 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    NEW    dossiers/TASK-319.md  -> does not exist; parent dossiers/ exists
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```

- [2026-09-19T15:45:00Z] [CX9] Completed independent review on disposable copies of `45f30b4`; only this dossier was changed in the TASK-319 worktree.

## Verdict

**ACCEPT.** TASK-295 R1 correctly addresses the sole TASK-317 rejection, with no regression found in the required scanner or provider behavior.

## Five-point re-verification

1. **Exactly the intended pins — PASS.** `infra/ci/lib/allowlist.mjs:28-35` defines exactly three `TOKEN_PINS`: the two `.codex/config.toml` pins (counts 1 and 2) and precisely one Grok production pin, `packages/agent-providers/src/providers/grok.ts`, count 2. There is no `providers.grok.test.ts` entry. The scanner self-test independently locks this at three pins in `infra/ci/test-banned-modes.mjs:318-328`.

2. **Grok test fixtures and behavior — PASS.** `packages/agent-providers/test/providers.grok.test.ts:9-11` assembles `ALWAYS_APPROVE` at runtime; its enabled behavior assertion remains in the full argument equality at `:22-38`, and the disabled behavior remains asserted at `:62-69`. The isolated `@oikonomos/agent-providers` suite passed all 104 tests, including `providers.grok.test.ts` (12 tests).

3. **Scanner and self-tests — PASS.** On a disposable worktree at exact tip `45f30b4`, `node infra/ci/banned-modes.mjs` printed clean and exited 0. `node --test infra/ci/test-banned-modes.mjs` passed 17/17. The count-pinned implementation remains at `infra/ci/banned-modes.mjs:115-145` and its normal-repository clean assertion at `infra/ci/test-banned-modes.mjs:348-355` passed.

4. **Fresh mutation probes — PASS.** In two separate disposable archives of the exact tip, I made no change to the pin registry:
   - Added `[profiles.task319_extra]` with one additional `sandbox_mode = "danger-full-access"` occurrence. The scanner exited 1 and reported three actual key-form hits versus its pin of two.
   - Deleted exactly one existing `sandbox_mode = "danger-full-access"` line, leaving one verified occurrence. The scanner exited 1 and reported one actual key-form hit versus its pin of two.

   These prove the `.codex` pin cannot be widened or reduced without CI failure.

5. **`.codex` pin and retained carve-outs — PASS.** `.codex/**` remains an enforcement surface at `infra/ci/lib/allowlist.mjs:7-17`, and `isAllowlisted` rejects enforcement paths before considering the free-text allowlist at `:77-84`. The real config continues to contain the one short-flag comment at `.codex/config.toml:21` and two live key occurrences at `:23` and `:35`, matching the first two pins. `infra/ci/banned-modes-allowlist.txt:14-27` and the locked expected allowlist in `infra/ci/test-banned-modes.mjs:35-48` retain `autopilot.json` and `scripts/**` carve-outs.

## Commands and evidence

- `git diff --check mainco/master...task/TASK-295-s5` — clean.
- `node infra/ci/banned-modes.mjs` in disposable `45f30b4` worktree — exit 0, clean.
- `node --test infra/ci/test-banned-modes.mjs` in disposable `45f30b4` worktree — 17 passed, 0 failed.
- `powershell -ExecutionPolicy Bypass -File scripts\\test-isolated.ps1 -Root <disposable-45f30b4-worktree> -Filter @oikonomos/agent-providers` — 11 files / 104 tests passed, including `providers.grok.test.ts` 12/12; isolated `oikonomos_test` database.
- Extra occurrence archive probe — scanner exit 1, `pin mismatch: 3 hit(s), pinned 2`.
- Exactly-one-deleted archive probe — scanner exit 1, `pin mismatch: 1 hit(s), pinned 2`.

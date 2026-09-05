# TASK-161 — Fix `execvpe(/bin/bash)` failure in chatRunDriver's workspace test on Windows

## Work Log

### [2026-09-05T22:09:01Z] [GB]

Session start. `control.mode=strict`: PLAN.md not touched. Review_Findings empty
(first pass, not rework). No prior dossier. Created `task/TASK-161-gb` from
detached HEAD (`git checkout -b`). Preflight:

```text
[preflight] TASK-161 Owned_Paths inspected in E:/DELL-PROJECTS/wt-grok-GROKBOT-CLONE
[preflight] 1 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  FILE   services/worker/src/runWorkspace.test.ts  -> exists, 31 line(s), 1449 bytes
[preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
```

## Investigation

The failing isolation assertion is **not** in Owned_Paths.

`services/worker/src/runWorkspace.test.ts` (31 lines, the only granted file)
contains two filesystem-seam tests added by TASK-175's carve: create a tmpdir
workspace, then remove it. It does not spawn a process. Its own comment
states the TASK-153 end-to-end isolation proof stayed in
`chatRunDriver.test.ts`:

> The real end-to-end proof that a chat run actually receives this workspace
> as its Bash/Read cwd with an empty environment (TASK-153) stays in
> chatRunDriver.test.ts's real-Postgres integration suite.

That is exactly TASK-175's contract: "the existing chatRunDriver.test.ts
keeps every test that exercises the driver end-to-end." The TASK-153 test
is a driver-end-to-end test (`createChatRunDriver(...).run(...)` against
real Postgres, inspecting the SDK options bag then spawning a child with
the exact `cwd`/`env` the driver passed). It was never moved.

The spawn that fails is `services/worker/src/chatRunDriver.test.ts:367-377`:

```ts
const shell = process.platform === "win32" ? "bash.exe" : "bash";
const { stdout } = await execFileAsync(shell, ["-lc", `pwd; printf '\\n%s' \"$${secretName}\"`], {
  cwd: workspace,
  env: sdkOptions.env, // {}
});
```

Reproduced on this machine (win32, `DATABASE_URL` set). `where.exe bash.exe`
resolves to the WSL/Docker-Desktop stub (`C:\Windows\System32\bash.exe` and
the WindowsApps alias), not a POSIX shell. Direct `execFile('bash.exe',
['-lc','pwd'])` fails with the same message the suite reported:

```
WSL ERROR: CreateProcessCommon:551: chdir(/tmp/docker-desktop-root/run/desktop/mnt/host/e/DELL-PROJECTS/wt-grok-GROKBOT-CLONE) failed 5
WSL ERROR: CreateProcessCommon:559: execvpe(/bin/bash) failed: No such file or directory
```

Same failure with default env and with `env: {}`. Installing/fixing WSL
would not satisfy the AC ("without requiring WSL/bash.exe on PATH").

## Why this is OWNERSHIP_CONFLICT, not a local workaround

Acceptance criterion 3 is `pnpm -r test` for `services/worker` exits 0.
That suite still runs `chatRunDriver.test.ts`. Adding a Node-based
cwd/env proof inside `runWorkspace.test.ts` would be a *new* test; it
cannot stop the existing `execFileAsync("bash.exe")` call from failing.
Skipping or weakening the original assertion is forbidden by AC 2 and
would also require editing the unowned file.

No currently-active (non-done) task owns `chatRunDriver.test.ts`. TASK-163
and TASK-164 own `chatRunDriver.ts` (the driver, not the test). TASK-170
owns `runWorkspace.test.ts` and is sequenced after this task.

## Requested grant

Widen TASK-161 `Owned_Paths` to:

`services/worker/src/chatRunDriver.test.ts`

(`runWorkspace.test.ts` is not needed for the fix; keep or drop it as ORCH
prefers. If kept, TASK-170's Depends_On sequencing still applies.)

## Proposed fix (not applied — outside territory)

Replace the POSIX-shell spawn with Node itself, keeping the same
assertions: real child process, exact `cwd` + empty `env` from the SDK
options bag, secret injected on the *test process* must be absent in the
child, workspace directory gone after the run.

Sketch (for the re-dispatch, not committed):

```ts
const { stdout } = await execFileAsync(
  process.execPath,
  ["-e", "process.stdout.write(process.cwd() + '\\n' + String(process.env[" + JSON.stringify(secretName) + "] ?? ''))"],
  { cwd: workspace, env: sdkOptions.env },
);
```

`process.execPath` is always present. Empty `env` is still genuinely
exercised. No bash/WSL.

Stopping point: blocked, waiting on Owned_Paths widen. No code written.
Next step after grant: edit `chatRunDriver.test.ts` as sketched, re-run
`pnpm --filter @oikonomos/worker test` then `pnpm -r test` for the worker.

### [2026-09-05T22:29:15Z] [GB]

Resume after ORCH grant. `control.mode=strict`: PLAN.md not touched.
Review_Findings: `—` (not a REWORK). Claim already recorded; continued on
existing `task/TASK-161-gb`.

Preflight against the **main checkout** PLAN.md (the hook/territory source;
worktree PLAN.md is still the pre-grant copy):

```text
[preflight] TASK-161 Owned_Paths inspected in E:/DELL-PROJECTS/GROKBOT-CLONE
[preflight] 1 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  FILE   services/worker/src/chatRunDriver.test.ts  -> exists, 865 line(s), 47601 bytes
[preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
```

Applied the sketched fix in-territory: TASK-153 isolation spawn now uses
`process.execPath -e` with the driver's exact `cwd` and empty `env`. cwd
is asserted equal to the workspace on every platform (stronger than the
old win32 `toContain("oikonomos-chat-")` WSL-path fallback). Parent-process
secret must still be absent in the child. Workspace still must be gone
after the run. No skip, no weakened assertion.

Standalone empty-env probe on this win32 machine: cwd_match=true,
secret_absent=true, spawn succeeds without SYSTEMROOT/PATH.

## Test evidence

`pnpm --filter @oikonomos/worker exec vitest run --config ../../packages/shared/vitest.config.ts --root . src/chatRunDriver.test.ts -t "TASK-153"`
→ 1 passed | 15 skipped (the isolation test itself).

`pnpm --filter @oikonomos/worker test` (isolated, twice after local
broker/db dist rebuilds that were stale vs source — not committed):
→ 18 files, 93/93 passed, including
`runs Bash in a fresh workspace with an empty environment and removes it afterward (TASK-153)`.

`pnpm --no-bail -r test`: `chatRunDriver.test.ts` 16/16 in that run
(TASK-153 included). Recursive summary 15 passes / 3 fails, all
unrelated to this change:
- `services/worker` 1 fail: `workerJobQueue.test.ts` pg-boss poll expected
  `lastFireStatus: queued`, got `missed` (shared-Postgres contention;
  same class as TASK-162). That file is 6/6 under the isolated worker run.
- `packages/db` 2 fails in `src/skills.test.ts` (TASK-176), out of territory.
- `services/control-api` 8 suites fail collecting `jose` (missing package),
  out of territory.

AC1/AC2/AC3 met by the isolated worker suite (the AC3 command for this
package). Ready for review.

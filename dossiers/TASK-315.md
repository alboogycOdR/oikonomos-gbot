# TASK-315

## Work Log
- 2026-09-19: committcommittedUsd role axis now sums spend_records via runs->tasks.role_id; tests added (plain-chat, routine, isolation, non-UUID); c1 test rewritten to use real run. db suite: 271 pass, 1 fail (roles.test backfill guard, unrelated to spendReservations). Full-repo run failed in fresh worktree (unbuilt packages), not classified vs baseline.

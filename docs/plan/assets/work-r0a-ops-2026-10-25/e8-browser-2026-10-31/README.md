# E8 golden tasks — browser live run 2026-10-31

**Not a pass.** This was a same-origin browser-driven run, not the Node cookie runner. It created 18 real tasks (6 golden tasks × 3 attempts) in the production Work org and evaluates them with the same `pilot-ops.mjs` rules.

## Result

- 18 attempts: 16 reached a terminal state with an artifact; 2 G03 attempts timed out after 180s while the Run was `waiting(reconcile)`.
- `evaluateGoldenSuite`: `passRatio=0.667`, `p95=185.464s`, `passed=false`.
- Per task: G01 3/3, G02 3/3, G03 1/3, G04 3/3, G05 0/3, G06 3/3.
- G05 all three attempts failed `length_in_range` (output 129–199 chars vs required 300–1500). Root cause: this runner adaptation sent `background: ""` even though golden tasks declare `background_chars` (G05=2500, G06=3000).
- G03 attempts 1 and 2 entered `waiting(reconcile)`; egress logs show provider exchanges completed around 30.7s and 19.3s, but no receipt reached finishing before the 180s poll deadline. Attempt 3 succeeded in 25s.

## Fixes made after this run

- `scripts/golden-tasks/run-golden-tasks.mjs` now synthesizes deterministic, customer-free background text of exactly `background_chars` for every task.
- Live submissions are paced at `WORK_PILOT_MIN_INTERVAL_MS` (default 24000ms, i.e. 2.5 starts/minute) to match the pilot assumption. Unit tests set it to 0.
- Neither fix has been validated with a complete live 18-run rerun yet.

## New open Runs created by this run

The run left 4 additional `waiting(reconcile)` Runs (all `workflow_status=Running`, `reservation_state=held`, `orphan=false`):

- `aef8e753-452f-4696-88b8-373cf656de4f`
- `15b65b68-0d90-4463-b383-262e66b1e22a`
- `14ccbfc8-d944-41a1-836a-c77149d1433a`
- `5f493d75-4a0b-4cd0-818c-9a06bc16b933`

Together with the 7 pre-existing held Runs, the 2026-10-31 05:17 UTC scan shows 11 open Runs, all `waiting`/`Running`/`held`/`orphan=false`. They need reconcile or a separate disposition decision; they were not cancelled or settled by this run.

## Evidence files

- `raw.json`: browser-side raw results (task ids, markdown, timings, errors).
- `pilot-run.json`: evaluation output from `pilot-ops.mjs`.

## Boundary

- Transport is browser same-origin `fetch`, not the Node runner with `WORK_PILOT_SESSION_COOKIE`; cookie injection remains unproven.
- The tasks are synthetic; no customer data. Reviewer approval and the 11-06 environment/reviewer gate remain external.
- The suite must be rerun with synthetic backgrounds and pacing before E8 can be claimed.

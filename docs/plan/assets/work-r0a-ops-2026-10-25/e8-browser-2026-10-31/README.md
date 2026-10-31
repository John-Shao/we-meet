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
- The background fix is covered by unit tests but not by a complete live 18-run rerun. The pacing fix was exercised in a partial live rerun and **did not eliminate the timeouts**.

## Paced partial rerun (05:46–05:52 UTC)

- Same browser transport, synthetic backgrounds, 24s minimum interval between submissions.
- 6 of 18 attempts completed before the queue was stopped: G01 3/3 succeeded; G02 attempt 1 succeeded; G02 attempt 2 timed out after 181s in `waiting(reconcile)`; G02 attempt 3 was aborted after the suite was already guaranteed to fail on p95.
- Because p95 is the maximum of 18 samples, any single 180s timeout makes `passed=false`. The paced rerun therefore cannot pass; it was stopped rather than generating 12 more tasks.
- Conclusion: start rate is not the primary cause. Long provider calls still cross the runtime lease/finishing window and leave Runs `waiting(reconcile)`. This needs a runtime lease/receipt or runner-reconcile design fix before E8 can pass.
- The two new waiting Runs from this rerun (`7ff316dd-46c6-4733-b63a-b9cba1f72105`, `f550e41f-cbee-4d5a-ae45-1dbde1bfd9a2`) were canceled; a post-cancel scan returned to 7 held Runs, all `orphan=false`.

## New open Runs created by this run

The first run left 4 additional `waiting(reconcile)` Runs (all `workflow_status=Running`, `reservation_state=held`, `orphan=false`):

- `aef8e753-452f-4696-88b8-373cf656de4f`
- `15b65b68-0d90-4463-b383-262e66b1e22a`
- `14ccbfc8-d944-41a1-836a-c77149d1433a`
- `5f493d75-4a0b-4cd0-818c-9a06bc16b933`

Together with the 7 pre-existing held Runs, the 05:17 UTC scan showed 11 open Runs. The four E8 Runs were canceled through `POST /work/v1/runs/{id}/cancel`; all four tasks moved to `run_canceled`/`canceled`, active_run_id null. A post-cancel scan returned to 7 held Runs, 0 orphan. The 7 pre-existing Runs were not touched.

## Timeout probe (05:54 UTC)

The production config had `WORK_ADVANCE_TIMEOUT_SECONDS` unset (default 30s) on the Go worker and `WORK_RUN_TIMEOUT_MS` unset (default 30000ms) on the Node runtime. Both were raised to 200s / 180000ms, with backups `/etc/work/work-worker.env.bak-20261031-135458` and `/etc/work/work-runtime.env.bak-20261031-135458`; both services restarted active.

One G02 attempt with 1200-char background was then run. The runtime child started at 13:55:08 and failed at 13:55:31 with `WAITING_RECONCILE` / `provider_unknown`; egress logged `exchange_done` after 22.1s. This is **not** the previous 30s cutoff: the provider outcome itself is still unknown (likely provider 429/5xx or receipt unavailable). The timeout increase is retained, but it is not sufficient for E8. The validation Run was canceled; scan returned to 7 held Runs.

## Evidence files

- `raw.json`: browser-side raw results from the first full 18-attempt run (task ids, markdown, timings, errors).
- `pilot-run.json`: evaluation output from `pilot-ops.mjs` for the first run.
- `paced-partial.json`: raw results from the paced partial rerun (6 attempts).

## Boundary

- Transport is browser same-origin `fetch`, not the Node runner with `WORK_PILOT_SESSION_COOKIE`; cookie injection remains unproven.
- The tasks are synthetic; no customer data. Reviewer approval and the 11-06 environment/reviewer gate remain external.
- The suite must be rerun with synthetic backgrounds and pacing before E8 can be claimed.

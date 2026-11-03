-- Pilot funnel metrics for Work R0a, computed from the database only.
--
-- Read-only: one row per metric, no writes, no content. This exists because D5 §10 lists four
-- funnel metrics (activation, technical success, acceptance, continued-after-acceptance) while the
-- only thing that ever computed them was the Node evaluator's own unit test - nothing produced the
-- events array it consumes. This file is that producer-side definition: read-only SQL over
-- work.task_event and work.task, per organization. It carries the four §10 metrics, the ratios the
-- ops model already defined, and continued_after_acceptance, which §10 asks for and no file defined
-- before this one.
--
-- The client telemetry layer is deliberately not the source. The destination ruling (task #14,
-- 2026-11-03) keeps the browser sink unconfigured and measures the funnel from facts the server
-- already writes.
--
-- Parameters, set by the caller before running this file:
--   SET work.org_id = '...';                             the organization to measure
--   SET app.org_id = '...';                              the session's tenant context
--   SET work.pilot_enabled_at = '2026-11-03T00:00:00Z';  when the org flag turned on
--   SET work.activation_threshold = '3';                 optional, D5 requires >= 3 seated members
--
-- work.org_id and app.org_id must name the same organization; see the guard below.
--
-- Ordering rule: work.task_event.seq is unique per task and strictly increasing (0002:449-463), so
-- every "happened after" test here compares seq rather than timestamps. Two facts written in one
-- transaction share a clock but never share a seq, and a window measured by created_at would let an
-- acceptance and the activity that follows it fall on the wrong side of the boundary.
--
-- metric                            numerator                          denominator            value
-- activation                        distinct submitters in window       threshold              1 when reached, else 0
-- technical_success_rate            runs that ended succeeded            succeeded + failed     ratio (run-outcome form)
-- artifact_success_rate             submitted tasks with a published version   tasks submitted in window   ratio (D5 §10 form)
-- acceptance_rate                   tasks accepted by version            tasks that awaited acceptance   ratio
-- reason_completion_share           completions without a version        all completions        ratio (high = output unused)
-- continued_after_acceptance        accepted tasks with later activity   accepted tasks         ratio
-- time_to_first_artifact_p50_seconds  -                                  -                      median seconds, submit to first publish

WITH p AS (
  SELECT
    current_setting('work.org_id', false) AS org_id,
    coalesce(nullif(current_setting('work.pilot_enabled_at', true), ''), 'epoch')::timestamptz
      AS enabled_at,
    coalesce(nullif(current_setting('work.activation_threshold', true), ''), '3')::int
      AS activation_threshold,
    -- Guard, and it has to be load-bearing rather than decorative: measuring an unset or misspelled
    -- organization would otherwise return a table of zeros, and on the pilot dashboard zeros are
    -- indistinguishable from "nobody activated yet" - which is how a go/no-go call gets made on a
    -- bug. The check is that the organization being measured is the one this session is entitled to
    -- see: app.org_id is what the FORCEd row-level policies read, work.org_id picks the report's
    -- organization, and a mismatch means either the parameter is wrong or the rows arriving below are
    -- already RLS-clipped to a different tenant. An existence test would have been the obvious
    -- formulation and is the wrong one - work.org is itself RLS-filtered, so it divides by zero for a
    -- perfectly valid organization the session simply cannot see.
    CASE WHEN coalesce(nullif(current_setting('work.org_id', true), ''), '<unset>') =
           coalesce(nullif(current_setting('app.org_id', true), ''), '<none>')
         THEN 1
         -- Casting the message to an integer fails with the text in the error, so an operator sees
         -- which of the two names was wrong instead of a bare "division by zero".
         ELSE (concat('pilot-metrics.sql: work.org_id=',
                      coalesce(nullif(current_setting('work.org_id', true), ''), '<unset>'),
                      ' but this session''s tenant is app.org_id=',
                      coalesce(nullif(current_setting('app.org_id', true), ''), '<none>'),
                      ' - SET both to the same organization'))::int
    END AS org_selected
),
ev AS (
  SELECT e.task_id, e.seq, e.type, e.payload
  FROM work.task_event e
  JOIN p ON p.org_id = e.org_id AND p.org_selected = 1
),
submitted AS (
  SELECT t.id AS task_id, t.owner_subject_id, t.created_at
  FROM work.task t
  JOIN p ON p.org_id = t.org_id AND p.org_selected = 1
  WHERE t.deleted_at IS NULL
    AND t.created_at >= p.enabled_at
    AND t.created_at < p.enabled_at + interval '14 days'
),
run_terms AS (
  SELECT
    count(*) FILTER (WHERE type = 'run.succeeded') AS succeeded,
    count(*) FILTER (WHERE type = 'run.failed') AS failed
  FROM ev
),
awaiting AS (
  SELECT DISTINCT task_id FROM ev WHERE type = 'task.awaiting_acceptance'
),
accepted AS (
  SELECT task_id, min(seq) AS accepted_seq
  FROM ev
  WHERE type = 'task.completed' AND payload ->> 'basis' = 'version'
  GROUP BY task_id
),
completions AS (
  SELECT
    count(*) FILTER (WHERE payload ->> 'basis' = 'reason') AS by_reason,
    count(*) AS all_completions
  FROM ev
  WHERE type = 'task.completed'
),
first_publish AS (
  SELECT task_id, min(seq) AS publish_seq
  FROM ev
  WHERE type = 'artifact.published'
  GROUP BY task_id
),
-- "Continued after acceptance" = the same task shows real work after its own acceptance event: a new
-- published version, a rename, or another run. An edit made before the acceptance is not
-- continuation, which is exactly what comparing seq against accepted_seq (instead of "any later row
-- exists") enforces.
continued AS (
  SELECT DISTINCT a.task_id
  FROM accepted a
  JOIN ev e ON e.task_id = a.task_id AND e.seq > a.accepted_seq
  WHERE e.type IN ('artifact.published', 'task.title_update', 'run.queued', 'run.succeeded')
),
ttfa AS (
  SELECT percentile_cont(0.5) WITHIN GROUP (
    ORDER BY extract(epoch FROM pub.created_at - sub.created_at)
  ) AS seconds
  FROM first_publish fp
  JOIN work.task_event sub ON sub.task_id = fp.task_id AND sub.type = 'task.submitted'
  JOIN work.task_event pub ON pub.task_id = fp.task_id AND pub.seq = fp.publish_seq
  JOIN p ON p.org_id = pub.org_id AND p.org_selected = 1
),
activation AS (
  SELECT count(DISTINCT owner_subject_id) AS submitters FROM submitted
)
SELECT 'activation' AS metric,
  (SELECT submitters FROM activation)::numeric AS numerator,
  (SELECT activation_threshold FROM p)::numeric AS denominator,
  ((SELECT submitters FROM activation) >= (SELECT activation_threshold FROM p))::int::numeric AS value
UNION ALL
SELECT 'technical_success_rate', rt.succeeded, rt.succeeded + rt.failed,
  CASE WHEN rt.succeeded + rt.failed = 0 THEN NULL
       ELSE round(rt.succeeded::numeric / (rt.succeeded + rt.failed), 4) END
FROM run_terms rt
UNION ALL
SELECT 'artifact_success_rate',
  (SELECT count(*) FROM first_publish WHERE task_id IN (SELECT task_id FROM submitted)),
  (SELECT count(*) FROM submitted),
  CASE WHEN (SELECT count(*) FROM submitted) = 0 THEN NULL
       ELSE round((SELECT count(*) FROM first_publish
         WHERE task_id IN (SELECT task_id FROM submitted))::numeric
         / (SELECT count(*) FROM submitted), 4) END
UNION ALL
SELECT 'acceptance_rate',
  (SELECT count(*) FROM accepted), (SELECT count(*) FROM awaiting),
  CASE WHEN (SELECT count(*) FROM awaiting) = 0 THEN NULL
       ELSE round((SELECT count(*) FROM accepted)::numeric
         / (SELECT count(*) FROM awaiting), 4) END
UNION ALL
SELECT 'reason_completion_share', c.by_reason, c.all_completions,
  CASE WHEN c.all_completions = 0 THEN NULL
       ELSE round(c.by_reason::numeric / c.all_completions, 4) END
FROM completions c
UNION ALL
SELECT 'continued_after_acceptance',
  (SELECT count(*) FROM continued), (SELECT count(*) FROM accepted),
  CASE WHEN (SELECT count(*) FROM accepted) = 0 THEN NULL
       ELSE round((SELECT count(*) FROM continued)::numeric
         / (SELECT count(*) FROM accepted), 4) END
UNION ALL
SELECT 'time_to_first_artifact_p50_seconds', NULL, NULL, round(t.seconds::numeric, 2)
FROM ttfa t
ORDER BY metric;

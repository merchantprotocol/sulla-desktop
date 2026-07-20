// Routine-stewardship spine (issue #499).
//
// Heartbeat is scored on recurring human work converted into standing assets —
// routines armed and how well they run over time — NOT tokens spent. To keep
// that scoring cheap to consume every cycle, the run-history "spine" is exposed
// as deterministic SQL views over the tables that already exist
// (`workflows` + `workflow_executions`). Everything else in #499
// (routines_digest, routine_report, find_repeated_tasks) reads from these views,
// so the aggregation logic lives in ONE place: the database, queryable via the
// existing `pg/*` catalog tools with zero LLM cost and no new model-facing tools.
//
// Views only — additive and fully reversible (`down` drops them, no data touched).

export const up = `
  -- ── Spine: one row per routine execution, joined to registry metadata ──────
  -- Normalizes the two id conventions in the wild: scheduled routines run as
  -- id 'workflow-<slug>', ad-hoc/planning ones run as the bare slug. Join is on
  -- workflow_executions.workflow_id = workflows.id (verified 1:1 in prod).
  CREATE OR REPLACE VIEW routine_run_history AS
  SELECT
    e.execution_id,
    COALESCE(w.source_template_slug, regexp_replace(e.workflow_slug, '^workflow-', '')) AS routine_slug,
    COALESCE(w.name, e.workflow_name)                                                    AS routine_name,
    e.workflow_id,
    e.status,
    e.started_at,
    e.completed_at,
    ROUND(EXTRACT(EPOCH FROM (e.completed_at - e.started_at)))::int                      AS duration_seconds,
    e.error,
    -- A run that is still 'running' but never ticked past its start and is over a
    -- day old is a zombie (died at start, never progressed, never auto-restarted).
    (e.status = 'running'
       AND e.updated_at = e.started_at
       AND e.started_at < NOW() - INTERVAL '1 day')                                      AS is_zombie
  FROM workflow_executions e
  LEFT JOIN workflows w ON w.id = e.workflow_id;

  -- ── Scorecard: the artifact the human reads — per registered routine ───────
  -- LEFT JOIN from workflows so a routine that is ARMED BUT NEVER FIRED still
  -- appears (fire_count = 0) — that silence is itself a signal worth surfacing.
  -- success_rate is completed / (completed + failed): in-flight 'running' and
  -- 'suspended' runs are excluded so a live run never counts as a failure (the
  -- rollup gotcha that makes a running row read as failed).
  -- authored_by is attributed HONESTLY: 'heartbeat' only where the routine's own
  -- description says so; everything else is 'unattributed' (not falsely claimed).
  CREATE OR REPLACE VIEW routine_scorecard AS
  SELECT
    w.source_template_slug                                                    AS routine_slug,
    w.name                                                                    AS routine_name,
    w.description                                                             AS problem,
    CASE
      WHEN w.description ILIKE '%heartbeat%' OR w.description ILIKE '%derived by%'
        THEN 'heartbeat'
      ELSE 'unattributed'
    END                                                                       AS authored_by,
    w.version,
    w.status,
    w.enabled,
    w.created_at,
    COUNT(e.execution_id)                                                     AS fire_count,
    COUNT(e.execution_id) FILTER (WHERE e.status = 'completed')               AS completed_count,
    COUNT(e.execution_id) FILTER (WHERE e.status = 'failed')                  AS failed_count,
    COUNT(e.execution_id) FILTER (WHERE e.status = 'running')                 AS running_count,
    COUNT(e.execution_id) FILTER (WHERE e.status = 'suspended')               AS suspended_count,
    COUNT(e.execution_id) FILTER (
      WHERE e.status = 'running'
        AND e.updated_at = e.started_at
        AND e.started_at < NOW() - INTERVAL '1 day')                          AS zombie_count,
    ROUND(
      100.0 * COUNT(e.execution_id) FILTER (WHERE e.status = 'completed')
      / NULLIF(COUNT(e.execution_id) FILTER (WHERE e.status IN ('completed', 'failed')), 0)
    )::int                                                                    AS success_rate_pct,
    MAX(e.started_at)                                                         AS last_run_at,
    (ARRAY_AGG(e.status ORDER BY e.started_at DESC))[1]                       AS last_run_status
  FROM workflows w
  LEFT JOIN workflow_executions e ON e.workflow_id = w.id
  GROUP BY
    w.source_template_slug, w.name, w.description,
    w.version, w.status, w.enabled, w.created_at;
`;

export const down = `
  DROP VIEW IF EXISTS routine_scorecard;
  DROP VIEW IF EXISTS routine_run_history;
`;

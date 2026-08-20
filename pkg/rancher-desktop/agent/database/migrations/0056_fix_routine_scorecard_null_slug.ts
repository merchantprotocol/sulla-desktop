// Migration 0056 — Fix routine_scorecard.routine_slug going NULL for core routines.
//
// `routine_scorecard` (0037) selected `w.source_template_slug` directly with no
// fallback. `source_template_slug` is only populated for routines imported from
// a `~/sulla/routines/<slug>/routine.yaml` file via `import_workflow`. The new
// "system" core routines (0055, e.g. `core-routine-dream-about-human`) are
// seeded directly by `CoreRoutineSeeder`, so `source_template_slug` is NULL —
// `routine_scorecard.routine_slug` (and everything downstream: `routine_exceptions`,
// `routines_digest`) rendered the literal string "null" instead of a real name.
//
// `routine_run_history` (0037) already solved this correctly for run rows:
//   COALESCE(w.source_template_slug, regexp_replace(e.workflow_slug, '^workflow-', ''))
// This applies the same fallback to the per-routine scorecard, using `w.id`
// (equivalent to `e.workflow_slug` for every row of a given workflow, and
// available without re-aggregating over workflow_executions).
//
// View-only, additive, fully reversible (`down` restores the exact 0037 view).

export const up = `
  CREATE OR REPLACE VIEW routine_scorecard AS
  SELECT
    COALESCE(w.source_template_slug, regexp_replace(w.id, '^workflow-', '')) AS routine_slug,
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
    w.id, w.source_template_slug, w.name, w.description,
    w.version, w.status, w.enabled, w.created_at;
`;

export const down = `
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

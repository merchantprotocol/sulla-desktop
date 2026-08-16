// Age-bound the digest's `failed` exception reason (issue #499 follow-up).
//
// The 0038 `routine_exceptions` view surfaces any ENABLED routine whose LAST run
// failed, with NO age bound — the intent being "unresolved until fixed/retired".
// For a SCHEDULED routine that is self-clearing: the next fire produces a newer
// non-failed `last_run_status` and the routine drops out of the digest.
//
// But a routine that CANNOT auto-produce a newer run — a chat/ad-hoc-triggered
// routine (e.g. `planning-triage`), or one whose only history is an orphaned run
// that died at start — has NO path to a fresher `last_run_status`. Its single
// stale `failed` row then pins the routine in `routine_exceptions` FOREVER, so
// the zero-LLM digest re-emits the same "N failed — needs a look" line on every
// Heartbeat cycle. The status CHECK constraint on `workflow_executions`
// (running|suspended|completed|failed) has no terminal "cancelled/dismissed"
// value, so the stale row can't even be honestly reclassified in place — the
// failure is genuinely unresolvable through data alone. Observed live
// 2026-08-14: `planning-triage` re-flagged every cycle off a single 2026-07-08
// orphan (a mis-triggered run that died at start; its real task shipped
// separately) — a standing per-cycle attention tax on a non-actionable red.
//
// Fix: bound the DIGEST's `failed` reason to failures whose last run is within
// the last 30 days. The digest is explicitly the "anti-token-burn, exceptions-
// ONLY, worth-a-glance" surface (see 0038 header) — a failure older than 30 days
// with no newer run is no longer news worth re-surfacing every cycle. This bounds
// ONLY the digest views; the full truth (failed_count, history, success_rate) is
// untouched in `routine_scorecard` / `routine_report`, so nothing is hidden from
// anyone who looks — only the every-cycle re-nag stops. 30 days keeps a WEEKLY
// routine's failure visible across ~4 more fire opportunities to self-heal, while
// letting truly stale / non-re-runnable failures age out of the noise. `zombie`
// (a stuck `running` row) and `new` (created <24h) reasons are deliberately left
// unbounded — a stuck job and a freshly-armed routine are always actionable.
//
// Follow-up (not this migration): a first-class terminal status (add 'cancelled'
// to the status CHECK) + a `resolve`/`dismiss` verb would give an EXPLICIT
// retire path, superseding the age heuristic. Tracked for a later cycle.
//
// Views only — CREATE OR REPLACE over the 0038 definitions; additive and fully
// reversible (`down` restores the unbounded 0038 views). No data touched.

export const up = `
  -- ── Exceptions: age-bound the failed reason (30-day digest window) ──────────
  CREATE OR REPLACE VIEW routine_exceptions AS
  SELECT
    s.routine_slug,
    s.routine_name,
    s.authored_by,
    s.status,
    s.enabled,
    s.fire_count,
    s.failed_count,
    s.zombie_count,
    s.last_run_at,
    s.last_run_status,
    s.created_at,
    ARRAY_REMOVE(ARRAY[
      CASE WHEN s.last_run_status = 'failed'
                AND s.last_run_at > NOW() - INTERVAL '30 days'   THEN 'failed'  END,
      CASE WHEN s.zombie_count > 0                               THEN 'zombie'  END,
      CASE WHEN s.created_at > NOW() - INTERVAL '24 hours'       THEN 'new'     END
    ], NULL) AS reasons
  FROM routine_scorecard s
  WHERE s.enabled
    AND (
         (s.last_run_status = 'failed' AND s.last_run_at > NOW() - INTERVAL '30 days')
      OR s.zombie_count > 0
      OR s.created_at > NOW() - INTERVAL '24 hours'
    );

  -- ── Summary: header failed_count matches the bounded exceptions ─────────────
  CREATE OR REPLACE VIEW routine_digest_summary AS
  SELECT
    COUNT(*)                                                        AS total_routines,
    COUNT(*) FILTER (WHERE enabled)                                 AS enabled_count,
    COUNT(*) FILTER (
      WHERE enabled AND last_run_status = 'failed'
        AND last_run_at > NOW() - INTERVAL '30 days')               AS failed_count,
    COUNT(*) FILTER (WHERE enabled AND zombie_count > 0)            AS zombie_count,
    COUNT(*) FILTER (
      WHERE enabled AND created_at > NOW() - INTERVAL '24 hours')   AS new_count
  FROM routine_scorecard;
`;

// Restore the unbounded 0038 definitions.
export const down = `
  CREATE OR REPLACE VIEW routine_exceptions AS
  SELECT
    s.routine_slug,
    s.routine_name,
    s.authored_by,
    s.status,
    s.enabled,
    s.fire_count,
    s.failed_count,
    s.zombie_count,
    s.last_run_at,
    s.last_run_status,
    s.created_at,
    ARRAY_REMOVE(ARRAY[
      CASE WHEN s.last_run_status = 'failed'                        THEN 'failed'  END,
      CASE WHEN s.zombie_count > 0                                  THEN 'zombie'  END,
      CASE WHEN s.created_at > NOW() - INTERVAL '24 hours'          THEN 'new'     END
    ], NULL) AS reasons
  FROM routine_scorecard s
  WHERE s.enabled
    AND (
         s.last_run_status = 'failed'
      OR s.zombie_count > 0
      OR s.created_at > NOW() - INTERVAL '24 hours'
    );

  CREATE OR REPLACE VIEW routine_digest_summary AS
  SELECT
    COUNT(*)                                                        AS total_routines,
    COUNT(*) FILTER (WHERE enabled)                                 AS enabled_count,
    COUNT(*) FILTER (WHERE enabled AND last_run_status = 'failed')  AS failed_count,
    COUNT(*) FILTER (WHERE enabled AND zombie_count > 0)            AS zombie_count,
    COUNT(*) FILTER (
      WHERE enabled AND created_at > NOW() - INTERVAL '24 hours')   AS new_count
  FROM routine_scorecard;
`;

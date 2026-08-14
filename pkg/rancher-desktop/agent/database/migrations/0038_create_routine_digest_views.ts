// Routine-digest views (issue #499, component 1: routines_digest).
//
// The `routines_digest` catalog tool injects a delta + exceptions-ONLY summary
// into Heartbeat's context every cycle — the anti-token-burn core. Successes are
// suppressed; an all-green cycle collapses to a single line. To keep generation
// zero-LLM and the aggregation logic in ONE place, the exception-detection SQL
// lives here as views over the `routine_scorecard` spine (migration 0029); the
// catalog tool is a thin formatter over these two views.
//
//  - routine_exceptions: one row per ENABLED routine that is currently an
//    exception worth surfacing — its last run failed, it has a zombie run, or it
//    was newly created in the last 24h. Everything green + unchanged is omitted,
//    so the tool only formats what deviates. `enabled` is required so archived/
//    disabled routines (which can't fire again) never add noise.
//  - routine_digest_summary: the headline counts for the one-line all-green case
//    ("N routines armed, all green, no change") and the digest header.
//
// NOTE (v1 scope): "a routine that should have fired and didn't" (missed
// scheduled fire) is deliberately NOT detected here — the schedule/cron lives
// inside workflows.definition jsonb and reliable missed-fire detection needs
// cron parsing. Tracked as a follow-up; failed/zombie/new cover the unambiguous
// exceptions today without false positives.
//
// Views only — additive and fully reversible (`down` drops them, no data touched).

export const up = `
  -- ── Exceptions: the only routines the digest surfaces ──────────────────────
  -- Reads the 0029 scorecard so the fire/fail/zombie rollups live in one place.
  -- A routine appears here ONLY if it deviates: last run failed (unresolved
  -- until fixed/retired), a zombie run is present, or it was created in the last
  -- 24h (newly armed — worth a glance). Disabled/archived routines are excluded:
  -- they can't fire again, so their state is not actionable.
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

  -- ── Summary: headline counts for the digest header / all-green one-liner ────
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

export const down = `
  DROP VIEW IF EXISTS routine_digest_summary;
  DROP VIEW IF EXISTS routine_exceptions;
`;

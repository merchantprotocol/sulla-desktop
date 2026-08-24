/**
 * WorkConveyorMetricsModel — read-only Projects conveyor-health & productivity
 * metrics (GitHub issue #717).
 *
 * Contract (issue acceptance criteria):
 *  - AC#1: every number documents its denominator + legacy-data handling in
 *    the comment above its query.
 *  - Stage grouping resolves the *semantic* lane role via the DB function
 *    resolve_work_task_lane_role(task_id, lane_key) so custom lane names stay
 *    compatible (issue Scope). work_tasks.status IS the lane key.
 *  - AC#7 query-performance: aggregates over indexed columns; every drill-down
 *    list is LIMITed. Optional project scoping uses a static guard
 *    ($1::text IS NULL OR <col> = $1) so the SQL stays constant/index-friendly.
 *  - Comments/narration are never counted as completion (issue Scope):
 *    completion is read only from terminal task state + the dispatch ledger.
 *
 * Read-only: no INSERT/UPDATE/DELETE.
 */
import { postgresClient } from '../PostgresClient';

export type SemanticStage =
  | 'backlog' | 'planning' | 'execution' | 'review' | 'blocked' | 'terminal' | 'manual';

export interface ConveyorMetricsOptions {
  /** Limit every metric to one project; null/undefined = whole portfolio. */
  projectId?: string | null;
  /** Rolling window for rate/throughput metrics (hours). Default 168 (7d). */
  windowHours?: number;
  /** Soft WIP ceiling for active execution leases. Default 6. */
  wipLimit?: number;
  /** Lease is stale/zombie when its heartbeat is older than this (minutes). Default 20. */
  staleMinutes?: number;
  /** Drill-down row cap. Default 20, hard-capped at 100. */
  drillLimit?: number;
}

const DEFAULT_WINDOW_HOURS = 168;
const DEFAULT_WIP_LIMIT = 6;
const DEFAULT_STALE_MINUTES = 20;
const DEFAULT_DRILL_LIMIT = 20;
const MAX_DRILL_LIMIT = 100;

function num(v: any): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function pid(o: ConveyorMetricsOptions): string | null { return o.projectId ?? null; }
function win(o: ConveyorMetricsOptions): number {
  return o.windowHours && o.windowHours > 0 ? Math.floor(o.windowHours) : DEFAULT_WINDOW_HOURS;
}
function stale(o: ConveyorMetricsOptions): number {
  return o.staleMinutes && o.staleMinutes > 0 ? Math.floor(o.staleMinutes) : DEFAULT_STALE_MINUTES;
}
function drill(o: ConveyorMetricsOptions): number {
  const d = o.drillLimit ?? DEFAULT_DRILL_LIMIT;
  return Math.max(1, Math.min(MAX_DRILL_LIMIT, Math.floor(d)));
}
function wipLimit(o: ConveyorMetricsOptions): number {
  return o.wipLimit && o.wipLimit > 0 ? Math.floor(o.wipLimit) : DEFAULT_WIP_LIMIT;
}

export interface StageCount {
  stage: SemanticStage; count: number;
  oldestTaskId: string | null; oldestTitle: string | null;
  oldestEnteredAt: string | null; oldestAgeSeconds: number | null;
}
export interface StageAge {
  stage: SemanticStage; sampleSize: number;
  p50AgeSeconds: number; p90AgeSeconds: number;
}
export interface Throughput { enteredReview: number; reviewsCompleted: number; reachedDone: number; }
export interface VerifierThroughput { completedReviews: number; perDay: number; activeVerificationLeases: number; }
export interface Rework { reviewed: number; reworked: number; reworkRate: number; avgRepairLoops: number; }
export interface CustodyRow {
  artifactType: string; total: number;
  structured: number; legacy: number; missing: number; invalid: number;
}
export interface WaitAdoption { blockedTotal: number; blockedWithActiveWait: number; adoptionRate: number; }
export interface StaleLeases { staleLeases: number; activeLeases: number; }
export interface WipPressure {
  activeExecutionWip: number; activeVerificationWip: number; staleWip: number;
  wipLimit: number; over: boolean; backpressureReason: string | null;
}
export interface Shipments { independentShipments: number; integrationTrainClosures: number; }

export class WorkConveyorMetricsModel {
  /**
   * AC#2 — current count and the exact oldest item per semantic stage.
   * Denominator: all non-archived work_tasks (each counted in exactly one
   * stage). Age = now() - last_moved_at (dwell in current lane). Returns the
   * oldest item's id/title so the UI can jump straight to it.
   * Legacy: last_moved_at is NOT NULL (defaulted at insert) — no null handling.
   */
  static async stageCounts(opts: ConveyorMetricsOptions = {}): Promise<StageCount[]> {
    const rows = await postgresClient.query(`
      WITH staged AS (
        SELECT t.id, t.title, t.last_moved_at,
               resolve_work_task_lane_role(t.id, t.status) AS stage
        FROM work_tasks t
        WHERE t.archived = false
          AND ($1::text IS NULL OR t.project_id = $1)
      ), ranked AS (
        SELECT s.*,
               ROW_NUMBER() OVER (PARTITION BY s.stage ORDER BY s.last_moved_at ASC) AS rn,
               COUNT(*)     OVER (PARTITION BY s.stage) AS stage_count
        FROM staged s
      )
      SELECT stage, stage_count AS count, id AS oldest_task_id, title AS oldest_title,
             last_moved_at AS oldest_entered_at,
             EXTRACT(EPOCH FROM (now() - last_moved_at))::bigint AS oldest_age_seconds
      FROM ranked WHERE rn = 1
      ORDER BY stage
    `, [pid(opts)]);
    return rows.map((r: any) => ({
      stage: r.stage as SemanticStage,
      count: num(r.count),
      oldestTaskId: r.oldest_task_id ?? null,
      oldestTitle: r.oldest_title ?? null,
      oldestEnteredAt: r.oldest_entered_at ? String(r.oldest_entered_at) : null,
      oldestAgeSeconds: r.oldest_age_seconds == null ? null : num(r.oldest_age_seconds),
    }));
  }

  /**
   * Median (p50) and p90 stage age over a selectable window.
   * Denominator: non-archived tasks whose last_activity_at falls in the window,
   * grouped by semantic stage. Age = now() - last_moved_at.
   */
  static async stageAgePercentiles(opts: ConveyorMetricsOptions = {}): Promise<StageAge[]> {
    const rows = await postgresClient.query(`
      SELECT resolve_work_task_lane_role(t.id, t.status) AS stage,
             COUNT(*) AS sample_size,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (now() - t.last_moved_at))) AS p50_age_seconds,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (now() - t.last_moved_at))) AS p90_age_seconds
      FROM work_tasks t
      WHERE t.archived = false
        AND ($1::text IS NULL OR t.project_id = $1)
        AND t.last_activity_at >= now() - make_interval(hours => $2)
      GROUP BY stage
      ORDER BY stage
    `, [pid(opts), win(opts)]);
    return rows.map((r: any) => ({
      stage: r.stage as SemanticStage,
      sampleSize: num(r.sample_size),
      p50AgeSeconds: num(r.p50_age_seconds),
      p90AgeSeconds: num(r.p90_age_seconds),
    }));
  }

  /**
   * Execution->review and review->done throughput over the window.
   * There is no transition-history table, so these are derived from the
   * authoritative dispatch ledger + terminal task state (never comments):
   *   entered_review    = distinct tasks with a verification dispatch STARTED in window.
   *   reviews_completed = distinct (task_id, review_generation_hash) FINISHED in window.
   *   reached_done      = tasks whose completed_at falls in window (status='done').
   * Denominator for each is stated inline; all three share the same window.
   */
  static async throughput(opts: ConveyorMetricsOptions = {}): Promise<Throughput> {
    const r = (await postgresClient.query(`
      SELECT
        (SELECT COUNT(DISTINCT d.task_id)
           FROM work_task_dispatches d JOIN work_tasks t ON t.id = d.task_id
           WHERE d.kind = 'verification' AND d.started_at >= now() - make_interval(hours => $2)
             AND ($1::text IS NULL OR t.project_id = $1)) AS entered_review,
        (SELECT COUNT(*) FROM (
              SELECT DISTINCT d.task_id, d.review_generation_hash
              FROM work_task_dispatches d JOIN work_tasks t ON t.id = d.task_id
              WHERE d.kind = 'verification' AND d.finished_at >= now() - make_interval(hours => $2)
                AND d.status <> 'cancelled' AND d.review_generation_hash IS NOT NULL
                AND ($1::text IS NULL OR t.project_id = $1)
           ) g) AS reviews_completed,
        (SELECT COUNT(*) FROM work_tasks t
           WHERE t.status = 'done' AND t.completed_at >= now() - make_interval(hours => $2)
             AND ($1::text IS NULL OR t.project_id = $1)) AS reached_done
    `, [pid(opts), win(opts)]))[0] || {};
    return {
      enteredReview: num(r.entered_review),
      reviewsCompleted: num(r.reviews_completed),
      reachedDone: num(r.reached_done),
    };
  }

  /**
   * AC#5 — verifier throughput + utilization, EXCLUDING duplicate/suppressed
   * generations. Duplicates are collapsed by DISTINCT (task_id,
   * review_generation_hash) — the same dedup key WorkTaskDispatchModel uses to
   * detect duplicate review generations. Suppressed generations
   * (terminal_reason ILIKE 'suppress%') and cancelled leases are excluded.
   * Denominator: distinct completed review generations in window.
   * perDay is completed_reviews normalised to a 24h rate.
   * Utilization is expressed as the count of currently-running verification
   * leases (no capacity value is stored in the schema).
   */
  static async verifierThroughput(opts: ConveyorMetricsOptions = {}): Promise<VerifierThroughput> {
    const hours = win(opts);
    const r = (await postgresClient.query(`
      SELECT
        (SELECT COUNT(*) FROM (
           SELECT DISTINCT d.task_id, d.review_generation_hash
           FROM work_task_dispatches d JOIN work_tasks t ON t.id = d.task_id
           WHERE d.kind = 'verification' AND d.finished_at >= now() - make_interval(hours => $2)
             AND d.status <> 'cancelled'
             AND COALESCE(d.terminal_reason, '') NOT ILIKE 'suppress%'
             AND d.review_generation_hash IS NOT NULL
             AND ($1::text IS NULL OR t.project_id = $1)
         ) g) AS completed_reviews,
        (SELECT COUNT(*) FROM work_task_dispatches d JOIN work_tasks t ON t.id = d.task_id
           WHERE d.kind = 'verification' AND d.status = 'running'
             AND ($1::text IS NULL OR t.project_id = $1)) AS active_verification_leases
    `, [pid(opts), hours]))[0] || {};
    const completed = num(r.completed_reviews);
    return {
      completedReviews: completed,
      perDay: hours > 0 ? completed / (hours / 24) : 0,
      activeVerificationLeases: num(r.active_verification_leases),
    };
  }

  /**
   * Rework rate + average repair loops from the custody ledger.
   * Denominator: execution dispatches FINISHED in window that were reviewed
   * (review_count > 0). reworkRate = reworked / reviewed. avgRepairLoops =
   * mean(repair_count) over reviewed. Empty denominator degrades to 0.
   */
  static async reworkRate(opts: ConveyorMetricsOptions = {}): Promise<Rework> {
    const r = (await postgresClient.query(`
      SELECT
        COUNT(*) FILTER (WHERE d.review_count > 0) AS reviewed,
        COUNT(*) FILTER (WHERE d.review_count > 0 AND d.repair_count > 0) AS reworked,
        COALESCE(AVG(d.repair_count) FILTER (WHERE d.review_count > 0), 0)::float8 AS avg_repair_loops
      FROM work_task_dispatches d JOIN work_tasks t ON t.id = d.task_id
      WHERE d.kind = 'execution' AND d.finished_at >= now() - make_interval(hours => $2)
        AND ($1::text IS NULL OR t.project_id = $1)
    `, [pid(opts), win(opts)]))[0] || {};
    const reviewed = num(r.reviewed);
    const reworked = num(r.reworked);
    return { reviewed, reworked, reworkRate: reviewed > 0 ? reworked / reviewed : 0, avgRepairLoops: num(r.avg_repair_loops) };
  }

  /**
   * AC#3 — structured custody completeness by artifact type. Denominator:
   * terminal (status='done') execution dispatches. Four disjoint classes:
   *   structured = real run + artifact_type + (content_hash OR artifact_ref)
   *   legacy     = run_kind='legacy-worker' (pre-custody rows; not penalised)
   *   missing    = real run, no artifact_type at all
   *   invalid    = real run, claims an artifact_type but no hash/ref/url locator
   */
  static async custodyCompleteness(opts: ConveyorMetricsOptions = {}): Promise<CustodyRow[]> {
    const rows = await postgresClient.query(`
      SELECT
        COALESCE(d.artifact_type, '(none)') AS artifact_type,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE d.run_kind <> 'legacy-worker' AND d.artifact_type IS NOT NULL
                           AND (d.content_hash IS NOT NULL OR d.artifact_ref IS NOT NULL)) AS structured,
        COUNT(*) FILTER (WHERE d.run_kind = 'legacy-worker') AS legacy,
        COUNT(*) FILTER (WHERE d.run_kind <> 'legacy-worker' AND d.artifact_type IS NULL) AS missing,
        COUNT(*) FILTER (WHERE d.run_kind <> 'legacy-worker' AND d.artifact_type IS NOT NULL
                           AND d.content_hash IS NULL AND d.artifact_ref IS NULL AND d.artifact_url IS NULL) AS invalid
      FROM work_task_dispatches d JOIN work_tasks t ON t.id = d.task_id
      WHERE d.kind = 'execution' AND t.status = 'done'
        AND ($1::text IS NULL OR t.project_id = $1)
      GROUP BY COALESCE(d.artifact_type, '(none)')
      ORDER BY total DESC
      LIMIT 50
    `, [pid(opts)]);
    return rows.map((r: any) => ({
      artifactType: String(r.artifact_type),
      total: num(r.total), structured: num(r.structured), legacy: num(r.legacy),
      missing: num(r.missing), invalid: num(r.invalid),
    }));
  }

  /**
   * AC#4 — durable-wait adoption for blocked external gates. Denominator:
   * non-archived tasks whose semantic stage is 'blocked'. A blocked task counts
   * as adopted only when it has a work_task_waits row with status='active'.
   */
  static async waitAdoption(opts: ConveyorMetricsOptions = {}): Promise<WaitAdoption> {
    const r = (await postgresClient.query(`
      WITH blocked AS (
        SELECT t.id FROM work_tasks t
        WHERE t.archived = false
          AND resolve_work_task_lane_role(t.id, t.status) = 'blocked'
          AND ($1::text IS NULL OR t.project_id = $1)
      )
      SELECT
        (SELECT COUNT(*) FROM blocked) AS blocked_total,
        (SELECT COUNT(*) FROM blocked b WHERE EXISTS (
           SELECT 1 FROM work_task_waits w WHERE w.task_id = b.id AND w.status = 'active')) AS blocked_with_active_wait
    `, [pid(opts)]))[0] || {};
    const total = num(r.blocked_total);
    const withWait = num(r.blocked_with_active_wait);
    return { blockedTotal: total, blockedWithActiveWait: withWait, adoptionRate: total > 0 ? withWait / total : 0 };
  }

  /**
   * Zombie/stale lease count. Denominator: currently-running dispatches
   * (execution + verification). A lease is stale when heartbeat_at is older
   * than staleMinutes (default 20).
   */
  static async staleLeases(opts: ConveyorMetricsOptions = {}): Promise<StaleLeases> {
    const r = (await postgresClient.query(`
      SELECT
        COUNT(*) FILTER (WHERE d.status = 'running' AND d.heartbeat_at < now() - make_interval(mins => $2)) AS stale_leases,
        COUNT(*) FILTER (WHERE d.status = 'running') AS active_leases
      FROM work_task_dispatches d JOIN work_tasks t ON t.id = d.task_id
      WHERE ($1::text IS NULL OR t.project_id = $1)
    `, [pid(opts), stale(opts)]))[0] || {};
    return { staleLeases: num(r.stale_leases), activeLeases: num(r.active_leases) };
  }

  /**
   * Dependency-held count. Denominator: non-archived, non-terminal tasks that
   * have a non-archived dependency on another non-terminal task.
   */
  static async dependencyHeld(opts: ConveyorMetricsOptions = {}): Promise<{ dependencyHeld: number }> {
    const r = (await postgresClient.query(`
      SELECT COUNT(DISTINCT t.id) AS dependency_held
      FROM work_tasks t
      JOIN work_task_dependencies dep ON dep.task_id = t.id AND dep.archived = false
      JOIN work_tasks dt ON dt.id = dep.depends_on_task_id
      WHERE t.archived = false
        AND resolve_work_task_lane_role(t.id, t.status) <> 'terminal'
        AND resolve_work_task_lane_role(dt.id, dt.status) <> 'terminal'
        AND ($1::text IS NULL OR t.project_id = $1)
    `, [pid(opts)]))[0] || {};
    return { dependencyHeld: num(r.dependency_held) };
  }

  /**
   * WIP limit and active backpressure reason. active_execution_wip is the count
   * of running execution leases; the soft limit is a configurable default (no
   * authoritative WIP store exists in the schema). backpressureReason is
   * derived: stale leases holding slots > wip saturation > idle.
   */
  static async wipPressure(opts: ConveyorMetricsOptions = {}): Promise<WipPressure> {
    const r = (await postgresClient.query(`
      SELECT
        COUNT(*) FILTER (WHERE d.kind = 'execution' AND d.status = 'running') AS active_execution_wip,
        COUNT(*) FILTER (WHERE d.kind = 'verification' AND d.status = 'running') AS active_verification_wip,
        COUNT(*) FILTER (WHERE d.status = 'running' AND d.heartbeat_at < now() - make_interval(mins => $2)) AS stale_wip
      FROM work_task_dispatches d JOIN work_tasks t ON t.id = d.task_id
      WHERE ($1::text IS NULL OR t.project_id = $1)
    `, [pid(opts), stale(opts)]))[0] || {};
    const activeExec = num(r.active_execution_wip);
    const staleWip = num(r.stale_wip);
    const limit = wipLimit(opts);
    const over = activeExec >= limit;
    let reason: string | null = null;
    if (staleWip > 0) reason = 'stale_leases_holding_slots';
    else if (over) reason = 'wip_limit_reached';
    else if (activeExec === 0) reason = 'idle';
    return {
      activeExecutionWip: activeExec,
      activeVerificationWip: num(r.active_verification_wip),
      staleWip, wipLimit: limit, over, backpressureReason: reason,
    };
  }

  /**
   * AC#6 — completed independent shipments separated from integration-train
   * closures. Denominator: tasks with status='done' and completed_at in window.
   * A done task is an INDEPENDENT shipment when it carries its own artifact
   * custody (an execution dispatch with content_hash or artifact_ref). Done
   * tasks closed WITHOUT their own custody are integration-train closures
   * (rolled up with another shipment) and are reported separately, never as
   * independent shipments. (No explicit integration-train marker exists in the
   * schema; artifact custody is the authoritative available signal.)
   */
  static async shipments(opts: ConveyorMetricsOptions = {}): Promise<Shipments> {
    const r = (await postgresClient.query(`
      WITH done AS (
        SELECT t.id,
          EXISTS (SELECT 1 FROM work_task_dispatches d
                  WHERE d.task_id = t.id AND d.kind = 'execution'
                    AND (d.content_hash IS NOT NULL OR d.artifact_ref IS NOT NULL)) AS has_custody
        FROM work_tasks t
        WHERE t.status = 'done' AND t.completed_at >= now() - make_interval(hours => $2)
          AND ($1::text IS NULL OR t.project_id = $1)
      )
      SELECT
        COUNT(*) FILTER (WHERE has_custody) AS independent_shipments,
        COUNT(*) FILTER (WHERE NOT has_custody) AS integration_train_closures
      FROM done
    `, [pid(opts), win(opts)]))[0] || {};
    return {
      independentShipments: num(r.independent_shipments),
      integrationTrainClosures: num(r.integration_train_closures),
    };
  }

  /** Bounded drill-down: oldest N tasks in a semantic stage (AC#2/#7). */
  static async oldestItems(opts: ConveyorMetricsOptions, stage: SemanticStage) {
    const rows = await postgresClient.query(`
      SELECT t.id, t.title, t.status, t.project_id,
             EXTRACT(EPOCH FROM (now() - t.last_moved_at))::bigint AS age_seconds,
             t.last_moved_at
      FROM work_tasks t
      WHERE t.archived = false
        AND resolve_work_task_lane_role(t.id, t.status) = $2
        AND ($1::text IS NULL OR t.project_id = $1)
      ORDER BY t.last_moved_at ASC
      LIMIT $3
    `, [pid(opts), stage, drill(opts)]);
    return rows.map((r: any) => ({
      id: r.id, title: r.title, status: r.status, projectId: r.project_id,
      ageSeconds: num(r.age_seconds), lastMovedAt: r.last_moved_at ? String(r.last_moved_at) : null,
    }));
  }

  /** Bounded drill-down: the stale/zombie running leases (AC#7). */
  static async staleLeaseItems(opts: ConveyorMetricsOptions = {}) {
    const rows = await postgresClient.query(`
      SELECT d.id AS dispatch_id, d.task_id, d.kind, d.agent_id, d.heartbeat_at,
             EXTRACT(EPOCH FROM (now() - d.heartbeat_at))::bigint AS silent_seconds, t.title
      FROM work_task_dispatches d JOIN work_tasks t ON t.id = d.task_id
      WHERE d.status = 'running' AND d.heartbeat_at < now() - make_interval(mins => $2)
        AND ($1::text IS NULL OR t.project_id = $1)
      ORDER BY d.heartbeat_at ASC
      LIMIT $3
    `, [pid(opts), stale(opts), drill(opts)]);
    return rows.map((r: any) => ({
      dispatchId: r.dispatch_id, taskId: r.task_id, kind: r.kind, agentId: r.agent_id,
      silentSeconds: num(r.silent_seconds), title: r.title,
    }));
  }

  /** Aggregate snapshot of every conveyor metric (all queries run concurrently). */
  static async snapshot(opts: ConveyorMetricsOptions = {}) {
    const [stages, agePercentiles, throughput, verifier, rework, custody, waits, leases, deps, wip, shipments] =
      await Promise.all([
        this.stageCounts(opts), this.stageAgePercentiles(opts), this.throughput(opts),
        this.verifierThroughput(opts), this.reworkRate(opts), this.custodyCompleteness(opts),
        this.waitAdoption(opts), this.staleLeases(opts), this.dependencyHeld(opts),
        this.wipPressure(opts), this.shipments(opts),
      ]);
    return {
      metric: 'conveyor_health',
      window_hours: win(opts),
      project_id: pid(opts),
      stages, agePercentiles, throughput, verifier, rework, custody,
      waits, leases, deps, wip, shipments,
    };
  }
}

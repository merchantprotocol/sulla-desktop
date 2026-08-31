/**
 * RoutineConcurrencyPolicy — unified, operator-configurable concurrency
 * controls for the protected Projects routines.
 *
 * The human configures a single global concurrent-agent limit under Language
 * Model Settings -> Project Automation. This module is the single place that
 * (a) resolves that limit from the DB-backed settings store, and (b) provides
 * an atomic reservation primitive so mechanical Projects work cannot overwhelm
 * system resources.
 *
 * Two enforcement surfaces share this limit:
 *   - The deterministic dispatcher pools (execution / review) bound how many
 *     dispatches they launch by resolveLimit(kind), which now simply mirrors
 *     the total limit (or MAX_ROUTINE_CONCURRENCY when unset).
 *   - acquire()/release() reserve a row in work_routine_slots under a
 *     transaction-scoped advisory lock, giving an exact, race-free ceiling
 *     across concurrent launches of any protected routine kind. The total
 *     ceiling checked here is the one and only concurrency knob.
 *
 * Enabled by default. When the human explicitly turns automatedProjectManagementEnabled
 * off, the resolver returns the caller's legacy value and callers skip
 * reservation, restoring pre-feature unlimited/hardcoded behaviour.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { postgresClient } from '../database/PostgresClient';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';

export type ProtectedRoutineKind =
  | 'planning'
  | 'execution'
  | 'review'
  | 'repair'
  | 'dreaming'
  | 'other';

export const PROTECTED_ROUTINE_KINDS: ProtectedRoutineKind[] = [
  'planning', 'execution', 'review', 'repair', 'dreaming', 'other',
];

/** Hard ceiling the UI and resolver both clamp to. */
export const MAX_ROUTINE_CONCURRENCY = 32;

/** Per-kind fallback used only while the master switch is disabled. */
export const DEFAULT_ROUTINE_LIMITS: Record<ProtectedRoutineKind, number> = {
  planning:  1,
  execution: 3,
  review:    3,
  repair:    2,
  dreaming:  1,
  other:     2,
};

export const MASTER_ENABLED_KEY = 'automatedProjectManagementEnabled';
export const TOTAL_LIMIT_KEY = 'routineConcurrencyTotalLimit';

/** Default total concurrent-agent limit when the human hasn't set one yet. */
export const DEFAULT_TOTAL_LIMIT = 5;

/** Advisory-lock key that serialises all slot acquisitions. */
const SLOT_ADVISORY_LOCK_KEY = 4823710298;

/** Slots un-heartbeated for longer than this are treated as crashed. */
const DEFAULT_STALE_SLOT_MINUTES = 45;

export interface RoutineSlotContext {
  owner?:  string | null;
  taskId?: string | null;
}

const wait = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

function clampLimit(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  if (floored < 0) return 0;
  if (floored > MAX_ROUTINE_CONCURRENCY) return MAX_ROUTINE_CONCURRENCY;
  return floored;
}

export class RoutineConcurrencyPolicy {
  static async isEnabled(): Promise<boolean> {
    return Boolean(await SullaSettingsModel.get(MASTER_ENABLED_KEY, true));
  }

  /**
   * Resolve the effective concurrent-running limit for a routine kind.
   *
   * When the feature is disabled we return the caller's legacy value (or the
   * built-in default) unchanged, restoring pre-feature behaviour. When
   * enabled there is no per-kind setting any more -- every kind shares the
   * single human-configured total concurrent-agent limit (or, when that is
   * unset/zero, the hard MAX_ROUTINE_CONCURRENCY safety ceiling). The real
   * cross-kind enforcement happens in acquire() via resolveTotalLimit(); this
   * just sizes how large a batch each dispatcher pool may attempt.
   */
  static async resolveLimit(kind: ProtectedRoutineKind, legacyFallback?: number): Promise<number> {
    const fallback = clampLimit(
      legacyFallback ?? DEFAULT_ROUTINE_LIMITS[kind],
      DEFAULT_ROUTINE_LIMITS[kind],
    );

    if (!(await this.isEnabled())) {
      return fallback;
    }

    const total = await this.resolveTotalLimit();
    return total ?? MAX_ROUTINE_CONCURRENCY;
  }

  static async resolveTotalLimit(): Promise<number | null> {
    if (!(await this.isEnabled())) return null;
    const raw = await SullaSettingsModel.get(TOTAL_LIMIT_KEY, DEFAULT_TOTAL_LIMIT);
    if (raw === null || raw === undefined || raw === '') return null;
    const value = clampLimit(Number(raw), 0);
    return value > 0 ? value : null;
  }

  /** Count active reservations of a kind (or all kinds when omitted). */
  static async runningCount(kind?: ProtectedRoutineKind): Promise<number> {
    const row = await postgresClient.queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM work_routine_slots
        WHERE ($1::text IS NULL OR kind = $1)`,
      [kind ?? null],
    );
    return Number(row?.count || 0);
  }

  /**
   * Atomically reserve one slot for a routine kind when capacity allows.
   * Returns the slot id on success, or null when the per-kind (or total)
   * ceiling is already reached. The advisory lock makes the count-then-insert
   * race-free across concurrent callers.
   */
  static async acquire(
    kind: ProtectedRoutineKind,
    limit: number,
    context: RoutineSlotContext = {},
  ): Promise<string | null> {
    if (limit <= 0) return null;
    const totalLimit = await this.resolveTotalLimit();
    return postgresClient.transaction(async(client: PoolClient) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [SLOT_ADVISORY_LOCK_KEY]);
      const kindRow = await client.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM work_routine_slots WHERE kind = $1',
        [kind],
      );
      if (Number(kindRow.rows[0]?.count || 0) >= limit) return null;
      if (totalLimit !== null) {
        const totalRow = await client.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM work_routine_slots',
        );
        if (Number(totalRow.rows[0]?.count || 0) >= totalLimit) return null;
      }
      const id = randomUUID();
      await client.query(
        'INSERT INTO work_routine_slots (id, kind, owner, task_id) VALUES ($1, $2, $3, $4)',
        [id, kind, context.owner ?? null, context.taskId ?? null],
      );
      return id;
    });
  }

  /** Queue behind capacity instead of converting routine backpressure into failure. */
  static async acquireWhenAvailable(
    kind: ProtectedRoutineKind,
    limit: number,
    context: RoutineSlotContext = {},
    pollMs = 1_000,
  ): Promise<string> {
    for (;;) {
      await this.reclaimStale();
      const slot = await this.acquire(kind, limit, context);
      if (slot) return slot;
      await wait(Math.max(100, pollMs));
    }
  }

  static async release(slotId: string): Promise<void> {
    await postgresClient.query('DELETE FROM work_routine_slots WHERE id = $1', [slotId]);
  }

  static async heartbeat(slotId: string): Promise<void> {
    await postgresClient.query(
      'UPDATE work_routine_slots SET heartbeat_at = now() WHERE id = $1',
      [slotId],
    );
  }

  /** Reclaim slots whose owner crashed without releasing them. */
  static async reclaimStale(staleMinutes: number = DEFAULT_STALE_SLOT_MINUTES): Promise<number> {
    const minutes = Math.max(1, Math.floor(staleMinutes));
    const rows = await postgresClient.query<{ id: string }>(
      `DELETE FROM work_routine_slots
        WHERE heartbeat_at <= now() - ($1 * interval '1 minute')
        RETURNING id`,
      [minutes],
    );
    return rows.length;
  }
}

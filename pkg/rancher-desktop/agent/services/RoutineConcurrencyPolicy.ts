/** Shared admission ceiling for concurrently dispatched routine workers. */
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

export const MASTER_ENABLED_KEY = 'automatedProjectManagementEnabled';

/** Advisory-lock key that serialises all slot acquisitions. */
const SLOT_ADVISORY_LOCK_KEY = 4823710298;

/** Slots un-heartbeated for longer than this are treated as crashed. */
const DEFAULT_STALE_SLOT_MINUTES = 45;

export interface RoutineSlotContext {
  owner?:  string | null;
  taskId?: string | null;
}

const wait = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

export class RoutineConcurrencyPolicy {
  static async isEnabled(): Promise<boolean> {
    return Boolean(await SullaSettingsModel.get(MASTER_ENABLED_KEY, true));
  }

  /** Keep worker capacity independent of whole-board consideration. */
  static async resolveLimit(_kind: ProtectedRoutineKind, _legacyFallback?: number): Promise<number> {
    return 5;
  }

  static async resolveTotalLimit(): Promise<number | null> {
    return 5;
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

  /** Reserve at most five workers under one database lock. */
  static async acquire(
    kind: ProtectedRoutineKind,
    _limit: number,
    context: RoutineSlotContext = {},
  ): Promise<string | null> {
    return postgresClient.transaction(async(client: PoolClient) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [SLOT_ADVISORY_LOCK_KEY]);
      const active = await client.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM work_routine_slots');
      if (Number(active.rows[0]?.count || 0) >= 5) return null;
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

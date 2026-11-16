// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { PoolClient } from 'pg';

/** Advisory-lock key that serialises all slot acquisitions. */
const SLOT_ADVISORY_LOCK_KEY = 4823710298;

export interface RoutineSlotQueryClient {
  query<T = any>(sql: string, params?: any[]): Promise<T[]>;
  queryOne<T = any>(sql: string, params?: any[]): Promise<T | null>;
  transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T>;
}

export interface RoutineSlotReservation {
  id:     string;
  kind:   string;
  owner:  string | null;
  taskId: string | null;
}

/** Persistence for shared routine worker slots (`work_routine_slots`). */
export class RoutineSlotRepository {
  constructor(private readonly client: RoutineSlotQueryClient) {}

  /** Count active reservations of a kind (or all kinds when kind is null). */
  async countActive(kind: string | null): Promise<number> {
    const row = await this.client.queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM work_routine_slots
        WHERE ($1::text IS NULL OR kind = $1)`,
      [kind],
    );
    return Number(row?.count || 0);
  }

  /** Insert the reservation only when fewer than `limit` slots are held, under one advisory lock. */
  async reserveUnderLimit(limit: number, reservation: RoutineSlotReservation): Promise<string | null> {
    return this.client.transaction(async(tx: PoolClient) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [SLOT_ADVISORY_LOCK_KEY]);
      const active = await tx.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM work_routine_slots');
      if (Number(active.rows[0]?.count || 0) >= limit) return null;
      await tx.query(
        'INSERT INTO work_routine_slots (id, kind, owner, task_id) VALUES ($1, $2, $3, $4)',
        [reservation.id, reservation.kind, reservation.owner, reservation.taskId],
      );
      return reservation.id;
    });
  }

  async delete(slotId: string): Promise<void> {
    await this.client.query('DELETE FROM work_routine_slots WHERE id = $1', [slotId]);
  }

  async touch(slotId: string): Promise<void> {
    await this.client.query(
      'UPDATE work_routine_slots SET heartbeat_at = now() WHERE id = $1',
      [slotId],
    );
  }

  /** Delete slots not heartbeated within `minutes`; returns how many were reclaimed. */
  async deleteStale(minutes: number): Promise<number> {
    const rows = await this.client.query<{ id: string }>(
      `DELETE FROM work_routine_slots
        WHERE heartbeat_at <= now() - ($1 * interval '1 minute')
        RETURNING id`,
      [minutes],
    );
    return rows.length;
  }
}

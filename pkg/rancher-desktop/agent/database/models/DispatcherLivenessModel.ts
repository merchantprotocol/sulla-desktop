import { postgresClient } from '../PostgresClient';

export type DispatcherTickOutcome =
  | 'never' | 'checking' | 'idle' | 'no-eligible-work'
  | 'actively-dispatching' | 'disabled' | 'error';

export interface DispatcherLivenessRecord {
  last_tick_started_at:    string | null;
  last_tick_at:            string | null;
  next_expected_tick_at:   string | null;
  last_outcome:            DispatcherTickOutcome;
  checking:                boolean;
  consecutive_wedge_count: number;
  wedge_count:             number;
  updated_at:              string;
}

export class DispatcherLivenessModel {
  static async beginTick(intervalMs: number): Promise<DispatcherLivenessRecord> {
    const row = await postgresClient.queryOne<DispatcherLivenessRecord>(`
      INSERT INTO dispatcher_liveness (
        id, last_tick_started_at, next_expected_tick_at, last_outcome,
        checking, consecutive_wedge_count, wedge_count, updated_at
      ) VALUES (true, now(), now() + ($1 * interval '1 millisecond'), 'checking', true, 0, 0, now())
      ON CONFLICT (id) DO UPDATE SET
        last_tick_started_at = now(),
        next_expected_tick_at = now() + ($1 * interval '1 millisecond'),
        last_outcome = 'checking',
        checking = true,
        consecutive_wedge_count = CASE WHEN dispatcher_liveness.checking
          OR dispatcher_liveness.next_expected_tick_at < now()
          THEN dispatcher_liveness.consecutive_wedge_count + 1 ELSE 0 END,
        wedge_count = dispatcher_liveness.wedge_count + CASE WHEN dispatcher_liveness.checking
          OR dispatcher_liveness.next_expected_tick_at < now() THEN 1 ELSE 0 END,
        updated_at = now()
      RETURNING *
    `, [intervalMs]);
    if (!row) throw new Error('Failed to record dispatcher tick start');
    return row;
  }

  static async completeTick(intervalMs: number, outcome: DispatcherTickOutcome): Promise<DispatcherLivenessRecord> {
    const row = await postgresClient.queryOne<DispatcherLivenessRecord>(`
      UPDATE dispatcher_liveness
         SET last_tick_at = now(),
             next_expected_tick_at = now() + ($1 * interval '1 millisecond'),
             last_outcome = $2,
             checking = false,
             consecutive_wedge_count = 0,
             updated_at = now()
       WHERE id = true
       RETURNING *
    `, [intervalMs, outcome]);
    if (!row) throw new Error('Failed to record dispatcher tick completion');
    return row;
  }

  static async get(): Promise<DispatcherLivenessRecord | null> {
    return postgresClient.queryOne<DispatcherLivenessRecord>(
      'SELECT * FROM dispatcher_liveness WHERE id = true',
    );
  }
}

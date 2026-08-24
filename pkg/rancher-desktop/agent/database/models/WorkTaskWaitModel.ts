import { createHash, randomUUID } from 'node:crypto';

import { postgresClient } from '../PostgresClient';
import type { PoolClient } from 'pg';

export type WorkTaskWaitKind = 'github_checks' | 'human_gate' | 'scheduled_time' | 'external_job';
export type WorkTaskWaitStatus = 'active' | 'changed' | 'satisfied' | 'cancelled' | 'failed';

export interface WorkTaskWaitRecord {
  id:                          string;
  task_id:                     string;
  wait_kind:                   WorkTaskWaitKind;
  target_key:                  string;
  target:                      Record<string, unknown>;
  last_observed_fingerprint:   string | null;
  next_check_at:               string;
  owner:                       string;
  status:                      WorkTaskWaitStatus;
  consecutive_unchanged_count: number;
  consecutive_failure_count:   number;
  first_checked_at:            string | null;
  last_checked_at:             string | null;
  last_error:                  string | null;
  due_at:                      string | null;
  created_at:                  string;
  updated_at:                  string;
  completed_at:                string | null;
}

export interface RegisterWaitInput {
  taskId:       string;
  waitKind:     WorkTaskWaitKind;
  targetKey:    string;
  target:       Record<string, unknown>;
  fingerprint?: string | null;
  nextCheckAt?: string;
  dueAt?:       string | null;
  owner?:       string;
}

export interface WaitObservation {
  fingerprint: string;
  outcome:     'pending' | 'satisfied' | 'failed';
  summary:     string;
  nextCheckAt: Date;
}

export interface WaitRegistration {
  wait:    WorkTaskWaitRecord;
  created: boolean;
}

export interface GithubCheckFingerprintInput {
  headSha: string;
  prState: string;
  runs:    { id?: number | string; name: string; status: string; conclusion?: string | null }[];
}

export class WorkTaskWaitModel {
  /**
   * True when the task still has a monitor-owned durable wait in the 'active'
   * state. A wait that has moved to 'changed', 'satisfied', 'cancelled', or
   * 'failed' no longer suppresses downstream transitions. Callers inside a
   * claim transaction pass their PoolClient so the check reads the live row
   * atomically with the FOR UPDATE task lock.
   */
  static async hasActiveWait(taskId: string, client?: PoolClient): Promise<boolean> {
    const sql = `SELECT id FROM work_task_waits WHERE task_id = $1 AND status = 'active' LIMIT 1`;
    const rows = client ? (await client.query(sql, [taskId])).rows : await postgresClient.query<{ id: string }>(sql, [taskId]);
    return rows.length > 0;
  }
  static fingerprintGithubChecks(input: GithubCheckFingerprintInput): string {
    const normalized = {
      headSha: input.headSha.trim().toLowerCase(),
      prState: input.prState.trim().toLowerCase(),
      runs:    [...input.runs]
        .map(run => ({
          id:         String(run.id ?? ''),
          name:       run.name.trim(),
          status:     run.status.trim().toLowerCase(),
          conclusion: (run.conclusion ?? '').trim().toLowerCase(),
        }))
        .sort((a, b) => `${ a.name }\0${ a.id }`.localeCompare(`${ b.name }\0${ b.id }`)),
    };

    return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  }

  static async register(input: RegisterWaitInput): Promise<WaitRegistration> {
    return postgresClient.transaction(async(client) => {
      const task = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM work_tasks WHERE id = $1 AND archived = false FOR UPDATE`,
        [input.taskId],
      );
      if (!task.rows[0]) throw new Error(`Task not found: ${ input.taskId }`);
      if (['done', 'cancelled', 'parked'].includes(task.rows[0].status)) {
        throw new Error(`Cannot register a wait for terminal task ${ input.taskId }`);
      }

      // A newer target supersedes an older active target of the same kind.
      await client.query(`
        UPDATE work_task_waits
           SET status = 'cancelled', completed_at = now(), updated_at = now(),
               last_error = 'superseded by newer target'
         WHERE task_id = $1 AND wait_kind = $2 AND status = 'active' AND target_key <> $3
      `, [input.taskId, input.waitKind, input.targetKey]);

      const existing = await client.query<WorkTaskWaitRecord>(`
        SELECT * FROM work_task_waits
         WHERE task_id = $1 AND wait_kind = $2 AND target_key = $3 AND status = 'active'
         LIMIT 1
      `, [input.taskId, input.waitKind, input.targetKey]);
      if (existing.rows[0]) return { wait: existing.rows[0], created: false };

      const inserted = await client.query<WorkTaskWaitRecord & { inserted: boolean }>(`
        INSERT INTO work_task_waits (
          id, task_id, wait_kind, target_key, target, last_observed_fingerprint,
          next_check_at, due_at, owner
        ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, COALESCE($7::timestamptz, now()), $8, $9)
        ON CONFLICT (task_id, wait_kind, target_key) WHERE status = 'active'
        DO UPDATE SET updated_at = work_task_waits.updated_at
        RETURNING *, (xmax = 0) AS inserted
      `, [
        `wait-${ randomUUID() }`, input.taskId, input.waitKind, input.targetKey,
        JSON.stringify(input.target), input.fingerprint ?? null, input.nextCheckAt ?? null,
        input.dueAt ?? null, input.owner ?? 'external-wait-monitor',
      ]);
      return { wait: inserted.rows[0], created: inserted.rows[0].inserted };
    });
  }

  static async get(id: string): Promise<WorkTaskWaitRecord | null> {
    return postgresClient.queryOne<WorkTaskWaitRecord>(
      'SELECT * FROM work_task_waits WHERE id = $1 LIMIT 1', [id],
    );
  }

  static async list(opts: { taskId?: string; status?: WorkTaskWaitStatus; limit?: number } = {}): Promise<WorkTaskWaitRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.taskId) {
      params.push(opts.taskId);
      conditions.push(`task_id = $${ params.length }`);
    }
    if (opts.status) {
      params.push(opts.status);
      conditions.push(`status = $${ params.length }`);
    }
    params.push(Math.max(1, Math.min(500, opts.limit ?? 100)));
    return postgresClient.query<WorkTaskWaitRecord>(`
      SELECT * FROM work_task_waits
      ${ conditions.length ? `WHERE ${ conditions.join(' AND ') }` : '' }
      ORDER BY updated_at DESC LIMIT $${ params.length }
    `, params);
  }

  static async claimDue(limit: number): Promise<WorkTaskWaitRecord[]> {
    return postgresClient.transaction(async(client) => {
      const result = await client.query<WorkTaskWaitRecord>(`
        SELECT w.*
          FROM work_task_waits w
          JOIN work_tasks t ON t.id = w.task_id
         WHERE w.status = 'active'
           AND w.next_check_at <= now()
           AND t.archived = false
           AND t.status NOT IN ('done', 'cancelled', 'parked')
         ORDER BY w.next_check_at ASC
         FOR UPDATE OF w SKIP LOCKED
         LIMIT $1
      `, [Math.max(1, Math.min(25, limit))]);

      if (result.rows.length > 0) {
        await client.query(`
          UPDATE work_task_waits
             SET next_check_at = now() + interval '5 minutes', updated_at = now()
           WHERE id = ANY($1::text[])
        `, [result.rows.map(row => row.id)]);
      }
      return result.rows;
    });
  }

  static async observe(id: string, observation: WaitObservation): Promise<{ changed: boolean; wait: WorkTaskWaitRecord | null }> {
    return postgresClient.transaction(async(client) => {
      const currentResult = await client.query<WorkTaskWaitRecord>(
        `SELECT * FROM work_task_waits WHERE id = $1 FOR UPDATE`, [id],
      );
      const current = currentResult.rows[0];
      if (current?.status !== 'active') return { changed: false, wait: current ?? null };

      const firstObservation = !current.last_observed_fingerprint;
      const changed = !firstObservation && current.last_observed_fingerprint !== observation.fingerprint;
      const terminal = observation.outcome !== 'pending';
      const nextStatus: WorkTaskWaitStatus = terminal
        ? (observation.outcome === 'satisfied' ? 'satisfied' : 'failed')
        : (changed ? 'changed' : 'active');
      const updated = await client.query<WorkTaskWaitRecord>(`
        UPDATE work_task_waits
           SET last_observed_fingerprint = $2,
               status = $3,
               next_check_at = $4,
               first_checked_at = COALESCE(first_checked_at, now()),
               last_checked_at = now(),
               consecutive_unchanged_count = CASE
                 WHEN $5::boolean OR $6::boolean THEN 0
                 ELSE consecutive_unchanged_count + 1 END,
               consecutive_failure_count = 0,
               last_error = NULL,
               updated_at = now(),
               completed_at = CASE WHEN $3 <> 'active' THEN now() ELSE NULL END
         WHERE id = $1
         RETURNING *
      `, [id, observation.fingerprint, nextStatus, observation.nextCheckAt, changed, terminal]);
      if (changed || terminal) {
        await client.query(`
          UPDATE work_tasks
             SET status = $2, assignee = $3, updated_at = now(),
                 last_moved_at = now(), last_activity_at = now(),
                 last_moved_by = 'external-wait-monitor'
           WHERE id = $1 AND status = 'blocked'
        `, [current.task_id, nextStatus === 'failed' ? 'planning' : 'in_review', nextStatus === 'failed' ? 'dispatcher' : 'heartbeat']);
      }
      return { changed: changed || terminal, wait: updated.rows[0] ?? null };
    });
  }

  static async recordFailure(id: string, message: string, nextCheckAt: Date, terminalAfter = 5): Promise<{ terminal: boolean; wait: WorkTaskWaitRecord | null }> {
    return postgresClient.transaction(async(client) => {
      const result = await client.query<WorkTaskWaitRecord>(`
        UPDATE work_task_waits
         SET consecutive_failure_count = consecutive_failure_count + 1,
             last_error = $2, last_checked_at = now(),
             first_checked_at = COALESCE(first_checked_at, now()),
             next_check_at = $3, updated_at = now(),
             status = CASE WHEN consecutive_failure_count + 1 >= $4 THEN 'failed' ELSE status END,
             completed_at = CASE WHEN consecutive_failure_count + 1 >= $4 THEN now() ELSE completed_at END
       WHERE id = $1 AND status = 'active'
       RETURNING *
      `, [id, message.slice(0, 2000), nextCheckAt, terminalAfter]);
      const wait = result.rows[0] ?? null;
      if (wait?.status === 'failed') {
        await client.query(`
          UPDATE work_tasks SET status = 'planning', assignee = 'dispatcher',
            updated_at = now(), last_moved_at = now(), last_activity_at = now(),
            last_moved_by = 'external-wait-monitor'
          WHERE id = $1 AND status = 'blocked'
        `, [wait.task_id]);
      }
      return { terminal: wait?.status === 'failed', wait };
    });
  }

  static async cancel(id: string, reason: string): Promise<WorkTaskWaitRecord | null> {
    return postgresClient.queryOne<WorkTaskWaitRecord>(`
      UPDATE work_task_waits
         SET status = 'cancelled', last_error = $2, updated_at = now(), completed_at = now()
       WHERE id = $1 AND status = 'active'
       RETURNING *
    `, [id, reason.slice(0, 1000)]);
  }

  static async activeTaskIds(): Promise<Set<string>> {
    const rows = await postgresClient.query<{ task_id: string }>(
      `SELECT DISTINCT task_id FROM work_task_waits WHERE status = 'active'`,
    );
    return new Set(rows.map(row => row.task_id));
  }

  static async summary(): Promise<{ active: number; oldest: string | null; unchanged: number; failures: number }> {
    const row = await postgresClient.queryOne<{ active: string; oldest: string | null; unchanged: string; failures: string }>(`
      SELECT COUNT(*) FILTER (WHERE status = 'active')::text AS active,
             MIN(created_at) FILTER (WHERE status = 'active')::text AS oldest,
             COALESCE(SUM(consecutive_unchanged_count), 0)::text AS unchanged,
             COALESCE(SUM(consecutive_failure_count), 0)::text AS failures
        FROM work_task_waits
    `);
    return {
      active:    Number(row?.active ?? 0),
      oldest:    row?.oldest ?? null,
      unchanged: Number(row?.unchanged ?? 0),
      failures:  Number(row?.failures ?? 0),
    };
  }
}

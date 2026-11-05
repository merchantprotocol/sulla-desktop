// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PostgresClient } from '../../database/PostgresClient';

export type AgentTaskWaitState = 'scheduled' | 'claimed' | 'cancelled';
export interface AgentTaskWait { jobId: string; taskIndex: number; wakeAt: Date; reason: string; state: AgentTaskWaitState; }

export class AgentTaskWaitRepository {
  constructor(private readonly database: PostgresClient) {}

  private map(row: any): AgentTaskWait {
    return { jobId: String(row.job_id), taskIndex: Number(row.task_index), wakeAt: new Date(row.wake_at), reason: String(row.reason), state: row.state };
  }

  async scheduleAndPark(wait: AgentTaskWait): Promise<boolean> {
    const client = await this.database.getClient();
    try {
      await client.query('BEGIN');
      const parked = await client.query(`UPDATE agent_jobs SET
        tasks = (SELECT jsonb_agg(CASE WHEN ordinal - 1 = $2::int THEN task || jsonb_build_object('status','parked','waitReason',$3,'wakeAt',$4::bigint) ELSE task END ORDER BY ordinal)
          FROM jsonb_array_elements(tasks) WITH ORDINALITY AS item(task, ordinal)),
        status = CASE WHEN NOT EXISTS (SELECT 1 FROM jsonb_array_elements(tasks) WITH ORDINALITY AS item(task, ordinal)
          WHERE ordinal - 1 <> $2::int AND task->>'status' IN ('queued','running')) THEN 'parked' ELSE status END,
        waiting_on_children = 0
        WHERE job_id=$1 AND status IN ('running','parked') AND tasks->($2::int)->>'status'='running' RETURNING job_id`,
      [wait.jobId, wait.taskIndex, wait.reason, wait.wakeAt.getTime()]);
      if (parked.rowCount !== 1) { await client.query('ROLLBACK'); return false; }
      await client.query(`INSERT INTO agent_task_waits (job_id, task_index, wake_at, reason, state) VALUES ($1,$2,$3,$4,'scheduled')
        ON CONFLICT (job_id, task_index) DO UPDATE SET wake_at=EXCLUDED.wake_at, reason=EXCLUDED.reason, state='scheduled', updated_at=now()`,
      [wait.jobId, wait.taskIndex, wait.wakeAt, wait.reason]);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async pending(jobId: string, taskIndex: number): Promise<AgentTaskWait | null> {
    const rows = await this.database.query<any>(`SELECT * FROM agent_task_waits WHERE job_id=$1 AND task_index=$2 AND state='scheduled'`, [jobId, taskIndex]);
    return rows[0] ? this.map(rows[0]) : null;
  }

  async claim(jobId: string, taskIndex: number): Promise<AgentTaskWait | null> {
    const rows = await this.database.query<any>(`UPDATE agent_task_waits SET state='claimed', updated_at=now() WHERE job_id=$1 AND task_index=$2 AND state='scheduled' RETURNING *`, [jobId, taskIndex]);
    return rows[0] ? this.map(rows[0]) : null;
  }

  async cancel(jobId: string, taskIndex: number): Promise<boolean> {
    const rows = await this.database.query<any>(`UPDATE agent_task_waits SET state='cancelled', updated_at=now() WHERE job_id=$1 AND task_index=$2 AND state='scheduled' RETURNING job_id`, [jobId, taskIndex]);
    return rows.length > 0;
  }

  async scheduled(): Promise<AgentTaskWait[]> {
    return (await this.database.query<any>(`SELECT * FROM agent_task_waits WHERE state='scheduled' ORDER BY wake_at`)).map(row => this.map(row));
  }
}

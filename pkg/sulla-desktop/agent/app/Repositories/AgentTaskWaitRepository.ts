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

  async schedule(wait: AgentTaskWait): Promise<void> {
    await this.database.query(`INSERT INTO agent_task_waits (job_id, task_index, wake_at, reason, state) VALUES ($1,$2,$3,$4,'scheduled')
      ON CONFLICT (job_id, task_index) DO UPDATE SET wake_at=EXCLUDED.wake_at, reason=EXCLUDED.reason, state='scheduled', updated_at=now()`,
    [wait.jobId, wait.taskIndex, wait.wakeAt, wait.reason]);
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

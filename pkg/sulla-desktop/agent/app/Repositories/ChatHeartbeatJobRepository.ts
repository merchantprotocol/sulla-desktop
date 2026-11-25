// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ChatHeartbeatConfig, ChatHeartbeatSetBy } from '@pkg/shared/chatHeartbeat';
import type { PostgresClient } from '../../database/PostgresClient';

export interface ChatHeartbeatJobRecord {
  jobId: string;
  taskIndex: number;
  threadId: string;
  channel: string;
  config: ChatHeartbeatConfig;
  startedAt: number;
  expiresAt: number;
  setBy: ChatHeartbeatSetBy;
}

export interface ChatHeartbeatJobRecordStore {
  save(record: ChatHeartbeatJobRecord): Promise<void>;
  all(): Promise<ChatHeartbeatJobRecord[]>;
  delete(jobId: string, taskIndex: number): Promise<void>;
}

/** Durable heartbeat state for delegated jobs, independent of any renderer tab. */
export class ChatHeartbeatJobRepository implements ChatHeartbeatJobRecordStore {
  constructor(private readonly database: PostgresClient) {}

  async save(record: ChatHeartbeatJobRecord): Promise<void> {
    await this.database.query(`INSERT INTO agent_job_heartbeats
      (job_id, task_index, thread_id, channel, config, started_at, expires_at, set_by)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
      ON CONFLICT (job_id, task_index) DO UPDATE SET
        thread_id = EXCLUDED.thread_id, channel = EXCLUDED.channel, config = EXCLUDED.config,
        started_at = EXCLUDED.started_at, expires_at = EXCLUDED.expires_at, set_by = EXCLUDED.set_by,
        updated_at = now()`, [record.jobId, record.taskIndex, record.threadId, record.channel,
      JSON.stringify(record.config), record.startedAt, record.expiresAt, record.setBy]);
  }

  async all(): Promise<ChatHeartbeatJobRecord[]> {
    const rows = await this.database.query<any>(`SELECT job_id, task_index, thread_id, channel, config,
      started_at, expires_at, set_by FROM agent_job_heartbeats ORDER BY started_at`);
    return rows.map(row => ({
      jobId: String(row.job_id), taskIndex: Number(row.task_index), threadId: String(row.thread_id),
      channel: String(row.channel), config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
      startedAt: Number(row.started_at), expiresAt: Number(row.expires_at), setBy: row.set_by,
    }));
  }

  async delete(jobId: string, taskIndex: number): Promise<void> {
    await this.database.query('DELETE FROM agent_job_heartbeats WHERE job_id = $1 AND task_index = $2', [jobId, taskIndex]);
  }
}

// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { ChatHeartbeatJobRepository, type ChatHeartbeatJobRecord } from '@pkg/agent/app/Repositories/ChatHeartbeatJobRepository';

class MemoryPostgresClient {
  private readonly rows: Array<Record<string, unknown>> = [];

  async query<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> {
    if (sql.startsWith('INSERT INTO agent_job_heartbeats')) {
      const [jobId, taskIndex, threadId, channel, config, startedAt, expiresAt, setBy] = values;
      const existing = this.rows.findIndex(row => row.job_id === jobId && row.task_index === taskIndex);
      const row = {
        job_id: jobId, task_index: taskIndex, thread_id: threadId, channel,
        config: JSON.parse(String(config)), started_at: startedAt, expires_at: expiresAt, set_by: setBy,
      };
      if (existing < 0) this.rows.push(row);
      else this.rows[existing] = row;
      return [];
    }
    if (sql.startsWith('SELECT job_id, task_index')) return [...this.rows] as T[];
    if (sql.startsWith('DELETE FROM agent_job_heartbeats')) {
      const [jobId, taskIndex] = values;
      const index = this.rows.findIndex(row => row.job_id === jobId && row.task_index === taskIndex);
      if (index >= 0) this.rows.splice(index, 1);
      return [];
    }
    throw new Error(`Unexpected SQL: ${ sql }`);
  }
}

describe('ChatHeartbeatJobRepository', () => {
  it('persists and restores a delegated heartbeat target with its original expiry and setter', async() => {
    // risk: a restart loses the delegated heartbeat or silently re-stamps its six-hour deadline.
    const repository = new ChatHeartbeatJobRepository(new MemoryPostgresClient() as any);
    const record: ChatHeartbeatJobRecord = {
      jobId: 'job-1', taskIndex: 2, threadId: 'worker-thread', channel: 'sulla-desktop',
      config: { intervalMinutes: 5, message: 'Keep working.', startedAt: 1000, expiresAt: 21_601_000, setBy: 'agent' },
      startedAt: 1000, expiresAt: 21_601_000, setBy: 'agent',
    };

    await repository.save(record);

    expect(await repository.all()).toEqual([record]);
    await repository.delete(record.jobId, record.taskIndex);
    expect(await repository.all()).toEqual([]);
  });
});

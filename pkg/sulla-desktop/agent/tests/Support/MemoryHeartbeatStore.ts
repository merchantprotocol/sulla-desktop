// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ChatHeartbeatJobRecord, ChatHeartbeatJobRecordStore } from '@pkg/agent/app/Repositories/ChatHeartbeatJobRepository';

/** In-memory stand-in for the agent_job_heartbeats table; the SQL itself is covered against real Postgres. */
export class MemoryHeartbeatStore implements ChatHeartbeatJobRecordStore {
  readonly records: ChatHeartbeatJobRecord[] = [];
  readonly deleted: Array<{ jobId: string; taskIndex: number }> = [];

  constructor(records: ChatHeartbeatJobRecord[] = []) { this.records.push(...records) }

  async save(record: ChatHeartbeatJobRecord): Promise<void> {
    const index = this.records.findIndex(row => row.jobId === record.jobId && row.taskIndex === record.taskIndex);
    if (index < 0) this.records.push(record);
    else this.records[index] = record;
  }

  async all(): Promise<ChatHeartbeatJobRecord[]> { return [...this.records] }

  async delete(jobId: string, taskIndex: number): Promise<void> {
    this.deleted.push({ jobId, taskIndex });
    const index = this.records.findIndex(row => row.jobId === jobId && row.taskIndex === taskIndex);
    if (index >= 0) this.records.splice(index, 1);
  }
}

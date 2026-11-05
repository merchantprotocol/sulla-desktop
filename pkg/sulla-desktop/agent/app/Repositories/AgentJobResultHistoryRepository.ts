// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { Repository } from '@sulla/foundation';
import { AgentJob as AgentJobModel } from '../Models/AgentJob';
import type { AgentJobResult, AgentJobTask } from '../../tools/agents/jobRegistry';

export interface AgentJobResultHistoryRecord {
  jobId: string;
  taskIndex: number;
  generation: number;
  taskStatus: AgentJobTask['status'];
  result?: unknown;
  completion?: AgentJobResult;
  summary?: string;
}

/** Append-only audit access for every settled generation of a delegated task. */
export class AgentJobResultHistoryRepository extends Repository<AgentJobModel> {
  protected readonly model = AgentJobModel;

  async record(record: AgentJobResultHistoryRecord): Promise<void> {
    await this.connection.run(`INSERT INTO agent_job_result_history
      (job_id, task_index, generation, task_status, result, completion, summary)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
      ON CONFLICT (job_id, task_index, generation) DO UPDATE SET
        task_status = EXCLUDED.task_status, result = EXCLUDED.result,
        completion = EXCLUDED.completion, summary = EXCLUDED.summary,
        recorded_at = now()`, [record.jobId, record.taskIndex, record.generation, record.taskStatus,
      JSON.stringify(record.result ?? null), JSON.stringify(record.completion ?? null), record.summary ?? null]);
  }

  async forTask(jobId: string, taskIndex: number): Promise<AgentJobResultHistoryRecord[]> {
    const rows = await this.connection.select(`SELECT * FROM agent_job_result_history
      WHERE job_id = $1 AND task_index = $2 ORDER BY generation`, [jobId, taskIndex]);
    return rows.map(row => ({ jobId: String(row.job_id), taskIndex: Number(row.task_index), generation: Number(row.generation),
      taskStatus: String(row.task_status) as AgentJobTask['status'], result: row.result ?? undefined,
      completion: row.completion as AgentJobResult | undefined, summary: row.summary == null ? undefined : String(row.summary) }));
  }
}

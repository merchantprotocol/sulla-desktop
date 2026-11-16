// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { Repository } from '@sulla/foundation';

import { AgentJob as AgentJobModel } from '../Models/AgentJob';

export interface AgentJobDrainOptions { retentionMs?: number; batchSize?: number; maxBatches?: number; pauseMs?: number }

/** Retention for agent_jobs: deletes terminal jobs whose delivery and lineage are settled. */
export class AgentJobRetentionRepository extends Repository<AgentJobModel> {
  protected readonly model = AgentJobModel;

  /** Delete one bounded set of terminal jobs whose delivery and lineage are settled. */
  async deleteExpiredBatch(retentionMs = 24 * 60 * 60 * 1000, limit = 500): Promise<number> {
    const rows = await this.connection.select(`WITH expired AS (
      SELECT job.job_id FROM agent_jobs job
      WHERE job.status IN ('completed', 'failed', 'stopped')
        AND job.finished_at < now() - ($1::bigint * interval '1 millisecond')
        AND job.waiting_on_children = 0
        AND NOT EXISTS (
          SELECT 1 FROM agent_job_tasks task
          WHERE task.job_id = job.job_id AND task.task_status IN ('queued', 'running', 'parked')
        )
        AND NOT EXISTS (
          SELECT 1 FROM agent_task_waits wait
          WHERE wait.job_id = job.job_id AND wait.state IN ('scheduled', 'claimed')
        )
        -- Delivery is settled when it was acknowledged, there is no parent to deliver to, no task
        -- still holds an unacknowledged completion (recovery would never send it), or the parent
        -- has had a week to take it (abandoned conversation).
        AND (job.completion_delivered_at IS NOT NULL
          OR job.parent_channel IS NULL OR job.parent_thread_id IS NULL
          OR NOT (job.tasks @? '$[*] ? (@.completion != null && !exists(@.completionDeliveredAt))')
          OR job.finished_at < now() - interval '7 days')
        AND NOT EXISTS (
          SELECT 1 FROM agent_jobs child
          WHERE child.parent_job_id = job.job_id
            AND (child.status IN ('running', 'parked')
              OR (child.completion_delivered_at IS NULL
                AND child.parent_channel IS NOT NULL AND child.parent_thread_id IS NOT NULL))
        )
        AND NOT EXISTS (
          SELECT 1 FROM agent_jobs parent
          WHERE parent.job_id = job.parent_job_id AND parent.status IN ('running', 'parked')
        )
      ORDER BY job.finished_at, job.job_id
      LIMIT $2
      FOR UPDATE OF job SKIP LOCKED
    ), deleted AS (
      DELETE FROM agent_jobs job USING expired WHERE job.job_id = expired.job_id
      RETURNING job.job_id
    ), released_claims AS (
      -- work_file_claims.owner_job_id has no FK; drop claims owned by deleted jobs in the same statement.
      DELETE FROM work_file_claims claim USING deleted WHERE claim.owner_job_id = deleted.job_id
    ) SELECT job_id FROM deleted`, [Math.max(0, Math.trunc(retentionMs)), Math.min(500, Math.max(1, Math.trunc(limit))) ]);
    return rows.length;
  }

  /**
   * Drain expired jobs in bounded batches with a short pause between them so the
   * one-time backlog clears without a long lock or CPU spike. Bounded per pass.
   */
  async drainExpired(options: AgentJobDrainOptions = {}): Promise<number> {
    const batchSize = Math.min(500, Math.max(1, Math.trunc(options.batchSize ?? 500)));
    const maxBatches = Math.max(1, Math.trunc(options.maxBatches ?? 10));
    const pauseMs = Math.max(0, options.pauseMs ?? 250);
    let total = 0;
    for (let batch = 0; batch < maxBatches; batch++) {
      const deleted = await this.deleteExpiredBatch(options.retentionMs, batchSize);
      total += deleted;
      if (deleted < batchSize) break;
      if (pauseMs > 0 && batch + 1 < maxBatches) await new Promise(resolve => setTimeout(resolve, pauseMs));
    }
    return total;
  }
}

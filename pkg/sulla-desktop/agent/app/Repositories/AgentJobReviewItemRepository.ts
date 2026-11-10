// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PostgresConnection } from '@sulla/foundation/postgres';

export type ReviewItemStatus = 'open' | 'acknowledged' | 'closed';
export interface AgentJobReviewItem {
  jobId: string; taskIndex: number; id: string; text: string; status: ReviewItemStatus;
  closureKind?: 'fixed' | 'wont_fix'; commit?: string; reason?: string;
}

/** Durable worker review obligations, isolated to a single delegated task. */
export class AgentJobReviewItemRepository {
  constructor(private readonly connection: Pick<PostgresConnection, 'select' | 'run'>) {}

  async createForTask(jobId: string, taskIndex: number, texts: string[]): Promise<string[]> {
    if (!texts.length) return [];
    const rows = await this.connection.select<any>(
      `WITH last_id AS (
         SELECT COALESCE(MAX(NULLIF(regexp_replace(item_id, '^R', ''), '')::int), 0) AS n
           FROM agent_job_review_items WHERE job_id = $1 AND task_index = $2
       ), inserted AS (
         INSERT INTO agent_job_review_items (job_id, task_index, item_id, text)
         SELECT $1, $2, 'R' || (last_id.n + items.ordinality), items.value
           FROM last_id CROSS JOIN UNNEST($3::text[]) WITH ORDINALITY AS items(value, ordinality)
         RETURNING item_id
       ) SELECT item_id FROM inserted ORDER BY CAST(SUBSTRING(item_id FROM 2) AS integer)`,
      [jobId, taskIndex, texts as unknown as string],
    );
    return (rows ?? []).map(row => row.item_id);
  }

  async itemsForTask(jobId: string, taskIndex: number, openOnly = false): Promise<AgentJobReviewItem[]> {
    const rows = await this.connection.select<any>(
      `SELECT * FROM agent_job_review_items WHERE job_id = $1 AND task_index = $2 ${openOnly ? "AND status <> 'closed'" : ''} ORDER BY CAST(SUBSTRING(item_id FROM 2) AS integer)`,
      [jobId, taskIndex],
    );
    return (rows ?? []).map(row => ({ jobId: row.job_id, taskIndex: Number(row.task_index), id: row.item_id, text: row.text, status: row.status, closureKind: row.closure_kind ?? undefined, commit: row.commit_sha ?? undefined, reason: row.reason ?? undefined }));
  }

  async openReviewItemsForTasks(jobIds: string[]): Promise<Record<string, AgentJobReviewItem[]>> {
    if (!jobIds.length) return {};
    const rows = await this.connection.select<any>("SELECT * FROM agent_job_review_items WHERE job_id = ANY($1::text[]) AND status <> 'closed' ORDER BY job_id, task_index, item_id", [jobIds as unknown as string]);
    const result: Record<string, AgentJobReviewItem[]> = {};
    for (const row of rows ?? []) (result[row.job_id] ??= []).push({ jobId: row.job_id, taskIndex: Number(row.task_index), id: row.item_id, text: row.text, status: row.status });
    return result;
  }

  async acknowledge(jobId: string, taskIndex: number, id: string): Promise<void> {
    await this.connection.run("UPDATE agent_job_review_items SET status = 'acknowledged', updated_at = now() WHERE job_id = $1 AND task_index = $2 AND item_id = $3 AND status = 'open'", [jobId, taskIndex, id]);
  }

  async close(jobId: string, taskIndex: number, id: string, kind: 'fixed' | 'wont_fix', commit: string | undefined, reason: string | undefined, closedBy: 'worker' | 'manager'): Promise<void> {
    await this.connection.run("UPDATE agent_job_review_items SET status = 'closed', closure_kind = $4, commit_sha = $5, reason = $6, closed_by = $7, updated_at = now() WHERE job_id = $1 AND task_index = $2 AND item_id = $3 AND status <> 'closed'", [jobId, taskIndex, id, kind, commit ?? null, reason ?? null, closedBy]);
  }
}

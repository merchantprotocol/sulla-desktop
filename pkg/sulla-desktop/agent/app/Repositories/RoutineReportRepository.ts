// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PostgresClient } from '../../database/PostgresClient';

/**
 * Reads the routine-health views (migration 0030) and workflow checkpoints used by
 * routine_report, routines_digest and find_repeated_tasks.
 */
export class RoutineReportRepository {
  constructor(private readonly client: Pick<PostgresClient, 'query'>) {}

  async digestSummary(): Promise<any> {
    return this.client.query('SELECT * FROM routine_digest_summary');
  }

  async exceptions(): Promise<any> {
    return this.client.query(`
    SELECT
      routine_slug,
      reasons,
      last_run_status,
      CASE
        WHEN last_run_at IS NULL THEN 'never fired'
        ELSE ROUND(EXTRACT(EPOCH FROM (NOW() - last_run_at)) / 60)::text || 'm ago'
      END AS last_run_ago
    FROM routine_exceptions
    ORDER BY (last_run_status = 'failed') DESC, routine_slug
  `);
  }

  async runs(slug: string | null, executionId: string | null, limit: number): Promise<any> {
    return this.client.query(`
        SELECT execution_id, routine_slug, routine_name, status,
               started_at, completed_at, duration_seconds, error, is_zombie
        FROM routine_run_history
        WHERE ($1::text IS NULL OR routine_slug = $1)
          AND ($2::text IS NULL OR execution_id = $2)
        ORDER BY started_at DESC
        LIMIT $3
      `, [slug, executionId, limit]);
  }

  async checkpoints(executionId: string): Promise<any> {
    return this.client.query(`
          SELECT sequence, node_id, node_label, node_subtype, node_output
          FROM workflow_checkpoints
          WHERE execution_id = $1
          ORDER BY sequence ASC
        `, [executionId]);
  }

  async promotionCandidates(threshold: number, limit: number): Promise<any> {
    return this.client.query(`
        SELECT
          signature,
          occurrences,
          conversations,
          span_days,
          to_char(last_seen, 'YYYY-MM-DD') AS last_seen
        FROM routine_promotion_candidates
        WHERE conversations >= $1
        ORDER BY conversations DESC, occurrences DESC
        LIMIT $2
      `, [threshold, limit]);
  }
}

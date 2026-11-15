// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { DecisionRecord } from '@pkg/shared/decisions';

interface DecisionQueryClient {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

export class PendingDecisionRepository {
  constructor(private readonly client: DecisionQueryClient) {}

  async findById(id: string): Promise<DecisionRecord | undefined> {
    const rows = await this.client.query<{ record: DecisionRecord }>(
      `SELECT record FROM human_decisions WHERE id=$1 LIMIT 1`, [id],
    );
    return rows[0]?.record;
  }

  /** Claim delivery of a late answer once, saving the answers with the claim. */
  async claimLateAnswer(id: string, answers: { question: string; selected: string[] }[] = []): Promise<boolean> {
    const rows = await this.client.query<{ id: string }>(`
      UPDATE human_decisions
      SET record = jsonb_set(jsonb_set(record, '{payload,lateAnswerDelivered}', 'true'::jsonb, true), '{answers}', $2::jsonb, true), updated_at = NOW()
      WHERE id = $1 AND status = 'expired'
        AND COALESCE((record->'payload'->>'lateAnswerDelivered')::boolean, false) = false
      RETURNING id`, [id, JSON.stringify(answers)]);
    return rows.length > 0;
  }

  /** Undo a claim whose delivery failed, so the answer can be sent again. The answers stay saved. */
  async releaseLateAnswer(id: string): Promise<void> {
    await this.client.query(`
      UPDATE human_decisions
      SET record = jsonb_set(record, '{payload,lateAnswerDelivered}', 'false'::jsonb, true), updated_at = NOW()
      WHERE id = $1`, [id]);
  }

  async findApproval(sessionId: string, key: string, value: string, now: number): Promise<DecisionRecord | undefined> {
    const rows = await this.client.query<{ record: DecisionRecord }>(`SELECT record FROM human_decisions
      WHERE status IN ('pending', 'deferred') AND session_id=$1 AND record->>'kind'='approval'
        AND record->'payload'->>$2=$3 AND (record->>'expiresAt')::bigint>$4
      ORDER BY updated_at DESC LIMIT 1`, [sessionId, key, value, now]);
    return rows[0]?.record;
  }
}

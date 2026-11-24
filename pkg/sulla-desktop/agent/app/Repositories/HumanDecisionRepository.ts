// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { DecisionRecord } from '@pkg/shared/decisions';

export interface HumanDecisionQueryClient {
  query<T = any>(sql: string, params?: any[]): Promise<T[]>;
}

/** Persistence for the durable human-decision inbox (`human_decisions`). */
export class HumanDecisionRepository {
  constructor(private readonly client: HumanDecisionQueryClient) {}

  async insert(record: DecisionRecord, sessionId: string): Promise<void> {
    await this.client.query('INSERT INTO human_decisions (id, session_id, status, record) VALUES ($1, $2, $3, $4::jsonb)',
      [record.id, sessionId, record.status, JSON.stringify(record)]);
  }

  /** Rows from another process session, or past their deadline, are expired as evidence. */
  async expireForeignOrOverdue(sessionId: string, now: number): Promise<void> {
    await this.client.query(`UPDATE human_decisions SET status = 'expired',
      record = jsonb_set(CASE WHEN record->>'kind'='question' AND NOT record ? 'attention' THEN record || '{"attention":"active"}'::jsonb ELSE record END, '{status}', '"expired"'), updated_at = NOW()
      WHERE status IN ('pending', 'deferred') AND NOT (record->>'kind'='question' AND COALESCE(record#>>'{payload,answerRoute}','')='inbox')
        AND (session_id <> $1 OR (record->>'expiresAt')::bigint <= $2)`, [sessionId, now]);
  }

  async listRecent(): Promise<DecisionRecord[]> {
    const rows = await this.client.query<{ record: DecisionRecord }>(
      "SELECT record FROM human_decisions ORDER BY (status IN ('pending', 'deferred')) DESC, updated_at DESC LIMIT 500");
    return rows.map(row => row.record);
  }

  /** Settle a pending/deferred decision owned by this session. True when a row changed. */
  async settle(id: string, status: string, next: DecisionRecord, sessionId?: string): Promise<boolean> {
    const rows = await this.client.query(`UPDATE human_decisions SET status = $2, record = $3::jsonb, updated_at = NOW()
        WHERE id = $1 AND status IN ('pending', 'deferred') AND ($4::text IS NULL OR session_id = $4)
          AND record->>'conversationId' = $5 RETURNING id`,
    [id, status, JSON.stringify(next), sessionId ?? null, next.conversationId]);
    return rows.length > 0;
  }

  async expirePending(id: string): Promise<void> {
    await this.client.query(`UPDATE human_decisions SET status = 'expired', record = jsonb_set(CASE WHEN record->>'kind'='question' AND NOT record ? 'attention' THEN record || '{"attention":"active"}'::jsonb ELSE record END, '{status}', '"expired"'), updated_at = NOW()
        WHERE id = $1 AND status IN ('pending', 'deferred')`, [id]);
  }
}

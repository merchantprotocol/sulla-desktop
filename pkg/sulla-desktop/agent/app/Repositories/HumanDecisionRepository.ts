// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { DecisionRecord } from '@pkg/shared/decisions';
import { DecisionRouteTransitionSqlBuilder, type DecisionRoutePatch, type DecisionSettlementStatus, type DecisionTransitionActor } from '../../repositories/DecisionRouteTransitionSqlBuilder';

export interface HumanDecisionQueryClient {
  query<T = any>(sql: string, params?: any[]): Promise<T[]>;
}

/** Persistence for the durable human-decision inbox (`human_decisions`). */
export class HumanDecisionRepository {
  constructor(private readonly client: HumanDecisionQueryClient, private readonly transitions = new DecisionRouteTransitionSqlBuilder()) {}

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
  async settle(id: string, status: string, next: DecisionRecord, sessionId: string): Promise<boolean> {
    const rows = await this.client.query(`UPDATE human_decisions SET status = $2, record = $3::jsonb, updated_at = NOW()
        WHERE id = $1 AND status IN ('pending', 'deferred') AND session_id = $4 RETURNING id`,
    [id, status, JSON.stringify(next), sessionId]);
    return rows.length > 0;
  }

  async claimHolder(id: string, expectedHolderIndex: number, actor: DecisionTransitionActor, routePatch: DecisionRoutePatch): Promise<boolean> {
    const query = this.transitions.claimHolder('approval', id, expectedHolderIndex, actor, routePatch);
    return (await this.client.query(query.sql, query.params)).length > 0;
  }

  async advanceHolder(id: string, expectedHolderIndex: number, actor: DecisionTransitionActor, routePatch: DecisionRoutePatch,
    history: NonNullable<DecisionRecord['route']>['history'][number], deadlineNow?: number): Promise<boolean> {
    const query = this.transitions.advanceHolder('approval', id, expectedHolderIndex, actor, routePatch, history, deadlineNow);
    return (await this.client.query(query.sql, query.params)).length > 0;
  }

  async settleAs(id: string, expectedHolderIndex: number, actor: DecisionTransitionActor, status: DecisionSettlementStatus,
    patch: Partial<Omit<DecisionRecord, 'route'>>, history: NonNullable<DecisionRecord['route']>['history'] = []): Promise<boolean> {
    const query = this.transitions.settleAs('approval', id, expectedHolderIndex, actor, status, { ...patch, status }, history);
    return (await this.client.query(query.sql, query.params)).length > 0;
  }

  /**
   * Settle a Files publish approval with no session owner, so it stays decidable after a restart.
   * Only an unexpired publish approval in its own conversation qualifies. True when a row changed.
   */
  async settleDurablePublish(id: string, status: string, next: DecisionRecord, now: number): Promise<boolean> {
    const rows = await this.client.query(`UPDATE human_decisions SET status = $2, record = $3::jsonb, updated_at = NOW()
        WHERE id = $1 AND status IN ('pending', 'deferred') AND record->>'kind' = 'approval'
          AND NULLIF(record#>>'{payload,filesPublishRequestId}', '') IS NOT NULL
          AND (record->>'expiresAt')::bigint > $4 AND record->>'conversationId' = $5 RETURNING id`,
    [id, status, JSON.stringify(next), now, next.conversationId]);
    return rows.length > 0;
  }

  async expirePending(id: string): Promise<DecisionRecord | undefined> {
    const rows = await this.client.query<{ record: DecisionRecord }>(`UPDATE human_decisions SET status = 'expired', record = jsonb_set(CASE WHEN record->>'kind'='question' AND NOT record ? 'attention' THEN record || '{"attention":"active"}'::jsonb ELSE record END, '{status}', '"expired"'), updated_at = NOW()
        WHERE id = $1 AND status IN ('pending', 'deferred') RETURNING record`, [id]);
    return rows[0]?.record;
  }
}

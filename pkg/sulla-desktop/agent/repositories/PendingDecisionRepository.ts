// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { DecisionRecord } from '@pkg/shared/decisions';

interface DecisionQueryClient {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

export class PendingDecisionRepository {
  constructor(private readonly client: DecisionQueryClient) {}

  async findApproval(sessionId: string, key: string, value: string, now: number): Promise<DecisionRecord | undefined> {
    const rows = await this.client.query<{ record: DecisionRecord }>(`SELECT record FROM human_decisions
      WHERE status IN ('pending', 'deferred') AND session_id=$1 AND record->>'kind'='approval'
        AND record->'payload'->>$2=$3 AND (record->>'expiresAt')::bigint>$4
      ORDER BY updated_at DESC LIMIT 1`, [sessionId, key, value, now]);
    return rows[0]?.record;
  }
}

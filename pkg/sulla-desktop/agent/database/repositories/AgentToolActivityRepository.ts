// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { postgresClient } from '@pkg/agent/database/PostgresClient';

export interface AgentToolActivitySqlClient { query<T = any>(sql: string, params?: unknown[]): Promise<T[]> }
export interface AgentToolActivityRow { at: string; actor: string; action: string; target: string }

/** Reads the persisted agent tool-result messages that the Security summary lists as recent activity. */
export class AgentToolActivityRepository {
  constructor(private readonly db: AgentToolActivitySqlClient = postgresClient) {}

  /** Newest first. Content-free: only the agent name, tool name and tool target are selected. */
  async recentToolActions(limit = 10): Promise<AgentToolActivityRow[]> {
    return this.db.query<AgentToolActivityRow>(`
      SELECT created_at AS at,
             COALESCE(NULLIF(meta->>'agentName', ''), NULLIF(meta->>'agent', ''), 'agent') AS actor,
             COALESCE(NULLIF(tool_name, ''), 'tool call') AS action,
             COALESCE(NULLIF(meta->>'toolTarget', ''), NULLIF(meta->>'toolCategory', ''), '') AS target
      FROM conversation_messages
      WHERE role = 'tool' AND deleted_at IS NULL
      ORDER BY created_at DESC, seq DESC
      LIMIT $1
    `, [limit]);
  }
}

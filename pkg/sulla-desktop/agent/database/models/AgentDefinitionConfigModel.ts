// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { postgresClient } from '../PostgresClient';

export interface AgentHeartbeatConfig {
  allowed: boolean;
  defaultIntervalMinutes: number;
  minIntervalMinutes: number;
  maxIntervalMinutes: number;
}

export interface AgentDefinitionConfigPatch {
  heartbeat?: AgentHeartbeatConfig;
  [key: string]: unknown;
}

/** JSONB-specific persistence kept separate from the core definition model. */
export class AgentDefinitionConfigModel {
  static async patch(id: string, patch: AgentDefinitionConfigPatch): Promise<boolean> {
    const row = await postgresClient.queryOne(
      `UPDATE agent_definitions SET config = COALESCE(config, '{}'::jsonb) || $2::jsonb, updated_at = now()
       WHERE id = $1 RETURNING id`,
      [id, JSON.stringify(patch)],
    );
    return Boolean(row);
  }

  static async heartbeat(id: string): Promise<AgentHeartbeatConfig | null> {
    const row = await postgresClient.queryOne('SELECT config->\'heartbeat\' AS heartbeat FROM agent_definitions WHERE id = $1 LIMIT 1', [id]);
    return row?.heartbeat && typeof row.heartbeat === 'object' && !Array.isArray(row.heartbeat)
      ? row.heartbeat as AgentHeartbeatConfig
      : null;
  }
}

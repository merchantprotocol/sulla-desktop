// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PostgresClient } from '../../database/PostgresClient';

/** Writes the `desktop_audit` table used by the agent-desktop tools. */
export class DesktopAuditRepository {
  constructor(private readonly client: Pick<PostgresClient, 'query'>) {}

  async insert(tool: string, app: string | undefined, action: string, success: boolean, durationMs: number): Promise<void> {
    await this.client.query(
      'INSERT INTO desktop_audit (tool, target_app, action, success, duration_ms) VALUES ($1,$2,$3,$4,$5)',
      [tool, app ?? null, action, success, durationMs],
    );
  }
}

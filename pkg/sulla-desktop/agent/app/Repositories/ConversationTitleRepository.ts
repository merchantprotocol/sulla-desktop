// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { DesktopPostgresConnection } from '../Database/DesktopPostgresConnection';

/** Bulk root-chat title reader for agent fleet projections. */
export class ConversationTitleRepository {
  constructor(private readonly connection: DesktopPostgresConnection) {}

  async titlesForThreadIds(threadIds: string[]): Promise<Record<string, string | null>> {
    const unique = [...new Set(threadIds.filter(Boolean))];
    if (unique.length === 0) return {};
    const rows = await this.connection.select<{ thread_id: string; title: string | null }>(
      `SELECT DISTINCT ON (COALESCE(thread_id, id)) COALESCE(thread_id, id) AS thread_id, title
         FROM conversation_history
        WHERE COALESCE(thread_id, id) = ANY($1::text[])
        ORDER BY COALESCE(thread_id, id), last_active_at DESC`,
      [unique as unknown as string],
    );
    return Object.fromEntries(rows.map(row => [row.thread_id, row.title]));
  }
}

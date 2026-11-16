// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PostgresClient } from '../../database/PostgresClient';

export interface NotificationHistoryInsert {
  title:     string;
  message:   string;
  targets:   string[];
  id:        string;
  silent:    boolean;
  delivered: boolean;
  error?:    string;
}

export interface NotificationHistoryFilter {
  /** Already validated target channel ("desktop" | "mobile"). */
  target?:      string;
  onlyFailures: boolean;
  /** ISO-8601 lower bound for sent_at. */
  sinceIso?:    string;
  limit:        number;
}

/** Reads and writes the `notifications` history table used by notify_user / notify_history. */
export class NotificationRepository {
  constructor(private readonly client: Pick<PostgresClient, 'query'>) {}

  async insert(row: NotificationHistoryInsert): Promise<void> {
    await this.client.query(
      `INSERT INTO notifications
         (title, message, targets, notification_id, silent, delivered, error)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)`,
      [row.title, row.message, JSON.stringify(row.targets), row.id, row.silent, row.delivered, row.error ?? null],
    );
  }

  async recent(filter: NotificationHistoryFilter): Promise<any[]> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filter.target) {
      params.push(JSON.stringify([filter.target]));
      where.push(`targets @> $${ params.length }::jsonb`);
    }
    if (filter.onlyFailures) where.push('delivered = false');
    if (filter.sinceIso) {
      params.push(filter.sinceIso);
      where.push(`sent_at >= $${ params.length }`);
    }

    const whereClause = where.length > 0 ? `WHERE ${ where.join(' AND ') }` : '';
    params.push(filter.limit);
    const limitIdx = params.length;

    const sql = `
      SELECT id, title, message, targets, notification_id, silent, delivered, error, sent_at
      FROM notifications
      ${ whereClause }
      ORDER BY sent_at DESC
      LIMIT $${ limitIdx }
    `;

    return this.client.query<any>(sql, params);
  }
}

// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PostgresClient } from '../../database/PostgresClient';

export interface AppleScriptAuditInsert {
  target_app:    string;
  script:        string;
  action_type?:  string;
  success:       boolean;
  durationMs:    number;
  error?:        string;
  responseChars: number;
}

export interface AppleScriptAuditFilter {
  targetApp?:   string;
  onlyFailures: boolean;
  /** ISO-8601 lower bound for executed_at. */
  sinceIso?:    string;
  limit:        number;
}

/** Reads and writes the `applescript_audit` table used by applescript_execute / applescript_audit_log. */
export class AppleScriptAuditRepository {
  constructor(private readonly client: Pick<PostgresClient, 'query'>) {}

  async insert(row: AppleScriptAuditInsert): Promise<void> {
    const actionType = row.action_type === 'write' ? 'write' : 'read';
    await this.client.query(
      `INSERT INTO applescript_audit
         (target_app, action_type, script, success, duration_ms, response_chars, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [row.target_app, actionType, row.script, row.success, row.durationMs, row.responseChars, row.error ?? null],
    );
  }

  async recent(filter: AppleScriptAuditFilter): Promise<any[]> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filter.targetApp) {
      params.push(filter.targetApp);
      where.push(`target_app = $${ params.length }`);
    }
    if (filter.onlyFailures) {
      where.push('success = false');
    }
    if (filter.sinceIso) {
      params.push(filter.sinceIso);
      where.push(`executed_at >= $${ params.length }`);
    }

    const whereClause = where.length > 0 ? `WHERE ${ where.join(' AND ') }` : '';
    params.push(filter.limit);
    const limitParamIdx = params.length;

    const sql = `
      SELECT id, target_app, action_type, script, success, duration_ms,
             response_chars, error, executed_at
      FROM applescript_audit
      ${ whereClause }
      ORDER BY executed_at DESC
      LIMIT $${ limitParamIdx }
    `;

    return this.client.query<any>(sql, params);
  }
}

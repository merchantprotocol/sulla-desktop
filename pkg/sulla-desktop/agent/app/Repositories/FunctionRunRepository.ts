// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PostgresClient } from '../../database/PostgresClient';

export interface FunctionRunInsert {
  slug:        string;
  version:     string;
  runtime?:    string;
  inputs:      Record<string, unknown>;
  outputs?:    Record<string, unknown>;
  success:     boolean;
  errorStage?: string;
  error?:      string;
  durationMs?: number;
  startedAt:   Date;
}

export interface FunctionRunFilter {
  slug?:        string;
  onlyFailures: boolean;
  /** ISO-8601 lower bound for started_at. */
  sinceIso?:    string;
  limit:        number;
}

/** Reads and writes the `function_runs` history table used by function_run / function_runs. */
export class FunctionRunRepository {
  constructor(private readonly client: Pick<PostgresClient, 'query'>) {}

  async insert(record: FunctionRunInsert, completedAt: Date): Promise<void> {
    await this.client.query(
      `INSERT INTO function_runs
         (slug, version, runtime, inputs, outputs, success, error_stage, error, duration_ms, started_at, completed_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11)`,
      [
        record.slug,
        record.version,
        record.runtime ?? null,
        JSON.stringify(record.inputs ?? {}),
        JSON.stringify(record.outputs ?? null),
        record.success,
        record.errorStage ?? null,
        record.error ?? null,
        record.durationMs ?? null,
        record.startedAt.toISOString(),
        completedAt.toISOString(),
      ],
    );
  }

  async recent(filter: FunctionRunFilter): Promise<any[]> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filter.slug) {
      params.push(filter.slug);
      where.push(`slug = $${ params.length }`);
    }
    if (filter.onlyFailures) where.push('success = false');
    if (filter.sinceIso) {
      params.push(filter.sinceIso);
      where.push(`started_at >= $${ params.length }`);
    }

    const whereClause = where.length > 0 ? `WHERE ${ where.join(' AND ') }` : '';
    params.push(filter.limit);
    const limitIdx = params.length;

    const sql = `
      SELECT id, slug, version, runtime, inputs, outputs, success, error_stage, error,
             duration_ms, started_at, completed_at
      FROM function_runs
      ${ whereClause }
      ORDER BY started_at DESC
      LIMIT $${ limitIdx }
    `;

    return this.client.query<any>(sql, params);
  }
}

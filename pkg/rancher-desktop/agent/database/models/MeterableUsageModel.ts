import { randomUUID } from 'crypto';
import { postgresClient } from '../PostgresClient';
import { isMeterableUsageDimension, type MeterableUsageDimension } from '../../usage/meterableUsageCatalog';

export interface UsageAccrualInput {
  profileId?: string;
  dimension: MeterableUsageDimension;
  quantity: number;
  idempotencyKey: string;
  source: string;
  metadata?: Record<string, unknown>;
}

export interface UsageTotal {
  profile_id: string;
  dimension: MeterableUsageDimension;
  quantity: number;
}

export class MeterableUsageModel {
  static async accrue(input: UsageAccrualInput): Promise<boolean> {
    if (!isMeterableUsageDimension(input.dimension) || !Number.isFinite(input.quantity) || input.quantity < 0) {
      throw new Error(`Invalid meterable usage accrual: ${ input.dimension }`);
    }
    const profileId = input.profileId?.trim() || 'default';
    const result = await postgresClient.queryWithResult(
      `INSERT INTO meterable_usage_accruals
        (id, profile_id, dimension, quantity, idempotency_key, source, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (profile_id, idempotency_key) DO NOTHING`,
      [randomUUID(), profileId, input.dimension, Math.floor(input.quantity), input.idempotencyKey, input.source, JSON.stringify(input.metadata ?? {})],
    );
    return result.rowCount === 1;
  }

  static async totals(profileId = 'default', since?: Date): Promise<UsageTotal[]> {
    const params: unknown[] = [profileId.trim() || 'default'];
    let where = 'WHERE profile_id = $1';
    if (since) { params.push(since.toISOString()); where += ' AND created_at >= $2'; }
    const rows = await postgresClient.queryAll<{ profile_id: string; dimension: MeterableUsageDimension; quantity: string }>(
      `SELECT profile_id, dimension, SUM(quantity)::text AS quantity
         FROM meterable_usage_accruals ${ where }
        GROUP BY profile_id, dimension ORDER BY dimension`, params,
    );
    return rows.map(row => ({ ...row, quantity: Number(row.quantity) }));
  }
}

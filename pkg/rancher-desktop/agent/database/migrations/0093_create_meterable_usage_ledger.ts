import type { PoolClient } from 'pg';

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS meterable_usage_accruals (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL DEFAULT 'default',
      dimension TEXT NOT NULL CHECK (dimension IN ('ai_tokens', 'transcription_minutes')),
      quantity BIGINT NOT NULL CHECK (quantity >= 0),
      idempotency_key TEXT NOT NULL,
      source TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (profile_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS meterable_usage_accruals_profile_dimension_created
      ON meterable_usage_accruals (profile_id, dimension, created_at DESC);
  `);
}

export async function down(client: PoolClient): Promise<void> {
  await client.query('DROP TABLE IF EXISTS meterable_usage_accruals');
}

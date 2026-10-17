CREATE TABLE IF NOT EXISTS local_vault_migration_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_fingerprint text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('running', 'committed', 'failed')),
  imported_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz
);

CREATE TABLE IF NOT EXISTS local_vault_migration_rows (
  source_kind text NOT NULL DEFAULT 'integration_value',
  source_value_id bigint NOT NULL,
  source_fingerprint text NOT NULL,
  item_id uuid NOT NULL REFERENCES items(id),
  migrated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source_kind, source_value_id)
);

CREATE TABLE IF NOT EXISTS local_vault_recovery (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  recovery_salt text NOT NULL,
  recovery_verifier text NOT NULL,
  encrypted_user_key jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);


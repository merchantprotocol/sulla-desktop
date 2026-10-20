CREATE TABLE files_backup_destinations (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('local', 'nas', 's3')),
  label TEXT NOT NULL,
  config JSONB NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE files_backup_snapshots (
  id UUID PRIMARY KEY,
  destination_id UUID NOT NULL REFERENCES files_backup_destinations(id) ON DELETE CASCADE,
  tier TEXT NOT NULL CHECK (tier IN ('hourly', 'daily', 'weekly', 'manual')),
  manifest_key TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  restore_verified_at TIMESTAMPTZ,
  UNIQUE(destination_id, manifest_key)
);

CREATE INDEX files_backup_snapshots_retention
  ON files_backup_snapshots(destination_id, tier, created_at DESC);

CREATE TABLE files_backup_runs (
  id UUID PRIMARY KEY,
  destination_id UUID NOT NULL REFERENCES files_backup_destinations(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  state TEXT NOT NULL CHECK (state IN ('running', 'verified', 'failed')),
  snapshot_id UUID REFERENCES files_backup_snapshots(id),
  error_code TEXT,
  error_message TEXT
);

CREATE TABLE files_backup_key_escrow (
  principal_id TEXT PRIMARY KEY,
  format_version INTEGER NOT NULL CHECK (format_version = 1),
  account_key_id TEXT NOT NULL,
  ciphertext_sha256 TEXT NOT NULL CHECK (ciphertext_sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

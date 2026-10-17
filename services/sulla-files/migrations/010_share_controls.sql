ALTER TABLE file_share_links
  ADD COLUMN IF NOT EXISTS password_hash TEXT,
  ADD COLUMN IF NOT EXISTS display_sharer_name BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS keep_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_viewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source_label TEXT,
  ADD COLUMN IF NOT EXISTS reconciliation_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS reconciliation_action TEXT CHECK (reconciliation_action IN ('delete')),
  ADD COLUMN IF NOT EXISTS reconciliation_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_file_share_links_reconciliation
  ON file_share_links(owner_user_id, reconciliation_updated_at)
  WHERE reconciliation_required = TRUE;

CREATE TABLE IF NOT EXISTS file_share_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id TEXT NOT NULL REFERENCES file_share_links(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('created', 'viewed', 'downloaded', 'updated', 'revoked')),
  detail TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_file_share_events_share_time
  ON file_share_events(share_id, occurred_at DESC);

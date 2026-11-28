-- SPDX-License-Identifier: GPL-2.0-or-later
-- Additive quarantine audit. Old ciphertext is retained at its recorded blob reference.
CREATE TABLE IF NOT EXISTS file_chunk_quarantine (
  id BIGSERIAL PRIMARY KEY,
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL,
  old_blob_ref TEXT NOT NULL,
  new_blob_ref TEXT NOT NULL,
  reason TEXT NOT NULL,
  quarantined_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS file_chunk_quarantine_lookup ON file_chunk_quarantine(collection_id, chunk_id, quarantined_at DESC);

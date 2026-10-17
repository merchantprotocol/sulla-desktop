-- Classify records written by the retired in-process runtime before the
-- container keyring is allowed to initialize. Those records used random keys
-- wrapped by an external master.key and must never receive derived replacements.
UPDATE collections c SET compatibility_state='legacy-external-data'
WHERE NOT EXISTS (SELECT 1 FROM files_collection_keys k WHERE k.collection_id=c.id)
  AND (
    c.kind='scratch'
    OR EXISTS (SELECT 1 FROM files f WHERE f.collection_id=c.id AND f.created_by_type='agent-run')
    OR c.encrypted_data_key <> '{}'::jsonb
    OR c.dedup_key_ciphertext <> '{}'::jsonb
  );

CREATE TABLE IF NOT EXISTS files_legacy_preflight (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(id),
  state TEXT NOT NULL CHECK(state IN ('clear','secure-import-required')),
  protected_prefix TEXT,
  reason TEXT,
  detected_at TIMESTAMPTZ,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

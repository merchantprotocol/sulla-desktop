-- Authoritative rotation metadata stays beside the local wrapped keys. Bundle
-- rows are immutable, opaque Vault-custody envelopes for that exact context.
ALTER TABLE files_collection_keys
  ADD COLUMN key_version INTEGER NOT NULL DEFAULT 1 CHECK (key_version > 0),
  ADD COLUMN key_epoch INTEGER NOT NULL DEFAULT 1 CHECK (key_epoch > 0);

CREATE TABLE files_collection_key_bundles (
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL,
  key_version INTEGER NOT NULL CHECK (key_version > 0),
  key_epoch INTEGER NOT NULL CHECK (key_epoch > 0),
  authority_key_id TEXT NOT NULL,
  authority_bundle JSONB NOT NULL,
  authority_registered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(collection_id, principal_id, key_version, key_epoch)
);
CREATE INDEX files_collection_key_bundles_principal
  ON files_collection_key_bundles(principal_id, collection_id, key_version DESC, key_epoch DESC);

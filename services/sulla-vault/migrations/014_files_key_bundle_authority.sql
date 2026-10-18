CREATE TABLE IF NOT EXISTS files_key_bundle_envelopes (
  principal_id text NOT NULL,
  collection_id text NOT NULL,
  key_version bigint NOT NULL CHECK (key_version > 0),
  key_epoch bigint NOT NULL CHECK (key_epoch > 0),
  authority_key_id text NOT NULL,
  authority_bundle jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, collection_id, key_version, key_epoch)
);

CREATE TABLE IF NOT EXISTS files_key_bundle_current (
  principal_id text NOT NULL,
  collection_id text NOT NULL,
  key_version bigint NOT NULL CHECK (key_version > 0),
  key_epoch bigint NOT NULL CHECK (key_epoch > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, collection_id),
  FOREIGN KEY (principal_id, collection_id, key_version, key_epoch)
    REFERENCES files_key_bundle_envelopes(principal_id, collection_id, key_version, key_epoch)
);

CREATE OR REPLACE FUNCTION prevent_files_key_bundle_envelope_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Files key bundle envelopes are immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS files_key_bundle_envelopes_immutable ON files_key_bundle_envelopes;
CREATE TRIGGER files_key_bundle_envelopes_immutable
  BEFORE UPDATE OR DELETE ON files_key_bundle_envelopes
  FOR EACH ROW EXECUTE FUNCTION prevent_files_key_bundle_envelope_mutation();

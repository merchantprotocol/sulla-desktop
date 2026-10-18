-- Legacy collections are never modified or exposed after conversion. Import
-- builds native shadows first, then publishes the complete set atomically.
ALTER TABLE collections ADD COLUMN IF NOT EXISTS legacy_source BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS published BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE collections SET legacy_source=TRUE
WHERE compatibility_state='legacy-external-data';

ALTER TABLE collections DROP CONSTRAINT IF EXISTS collections_agent_run_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS collections_native_agent_run_id
  ON collections(agent_run_id)
  WHERE agent_run_id IS NOT NULL AND legacy_source=FALSE AND published=TRUE;

CREATE TABLE files_legacy_imports (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(id),
  state TEXT NOT NULL CHECK(state IN ('staging','completed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE files_legacy_collection_map (
  source_collection_id UUID PRIMARY KEY REFERENCES collections(id),
  shadow_collection_id UUID UNIQUE NOT NULL REFERENCES collections(id),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE files_legacy_file_map (
  source_file_id UUID PRIMARY KEY REFERENCES files(id),
  shadow_file_id UUID UNIQUE NOT NULL,
  source_collection_id UUID NOT NULL REFERENCES collections(id),
  shadow_collection_id UUID NOT NULL REFERENCES collections(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE files_legacy_version_map (
  source_version_id UUID PRIMARY KEY REFERENCES file_versions(id),
  shadow_version_id UUID UNIQUE NOT NULL,
  shadow_manifest_hash TEXT,
  plaintext_sha256 TEXT,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE files_legacy_audit_map (
  source_audit_id BIGINT PRIMARY KEY REFERENCES audit_log(id),
  shadow_audit_id BIGINT UNIQUE NOT NULL REFERENCES audit_log(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX files_legacy_file_map_collection ON files_legacy_file_map(source_collection_id);

INSERT INTO files_protected_files(file_id)
SELECT f.id FROM files f JOIN collections c ON c.id=f.collection_id WHERE c.legacy_source=TRUE
ON CONFLICT DO NOTHING;

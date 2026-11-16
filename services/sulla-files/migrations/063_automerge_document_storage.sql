-- SPDX-License-Identifier: GPL-2.0-or-later
-- Separate the current CRDT document from the compact per-version head index.
-- The online backfill/pruner populates this table in bounded transactions so
-- this schema migration never scans or rewrites the large BYTEA table.
CREATE TABLE IF NOT EXISTS file_automerge_docs (
  file_id UUID PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  document BYTEA NOT NULL,
  heads JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE file_automerge_versions ALTER COLUMN document DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_file_automerge_versions_file_heads
  ON file_automerge_versions(file_id, version_id);

-- Seed one full document per file from its current version. This is one
-- set-based, restart-safe operation; historical snapshots are retained here
-- because SQL cannot decode Automerge to prove that their heads are reachable.
-- The Files service prunes those snapshots in bounded per-file saves after
-- checking Automerge's actual change graph.
INSERT INTO file_automerge_docs(file_id,document,heads)
SELECT f.id,v.document,v.heads
FROM files f
JOIN file_automerge_versions v ON v.version_id=f.current_version_id AND v.file_id=f.id
WHERE v.document IS NOT NULL
ON CONFLICT(file_id) DO NOTHING;

-- The current version is now represented in file_automerge_docs. Keep its
-- small heads index but remove the duplicate full document.
UPDATE file_automerge_versions v SET document=NULL
FROM files f
WHERE f.current_version_id=v.version_id AND f.id=v.file_id
  AND v.document IS NOT NULL
  AND EXISTS (SELECT 1 FROM file_automerge_docs d WHERE d.file_id=f.id);

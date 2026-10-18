ALTER TABLE collections ADD COLUMN IF NOT EXISTS thread_id TEXT;
CREATE INDEX IF NOT EXISTS idx_collections_owner_thread_run
  ON collections(owner_user_id, thread_id, agent_run_id);

-- Old in-process writers may have committed rows whose chunks and random keys
-- live outside the authoritative container. Keep those rows visible as an
-- explicit migration state; never pretend a replacement key makes them usable.
ALTER TABLE collections ADD COLUMN IF NOT EXISTS compatibility_state TEXT NOT NULL DEFAULT 'native'
  CHECK (compatibility_state IN ('native', 'legacy-external-data'));
UPDATE collections c SET compatibility_state='legacy-external-data'
WHERE NOT EXISTS (SELECT 1 FROM files_collection_keys k WHERE k.collection_id=c.id)
  AND (
    c.kind='scratch'
    OR (c.kind='knowledge' AND c.name='Knowledge' AND EXISTS (
      SELECT 1 FROM files f WHERE f.collection_id=c.id AND f.created_by_type='agent-run'
    ))
  );

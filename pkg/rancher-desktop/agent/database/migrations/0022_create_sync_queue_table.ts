// sync_queue — pending local mutations waiting to be pushed to sulla-workers.
// Same semantics as the mobile SQLite schema (v1): a single pending op per
// (table_name, record_key) — if the user edits the same row twice before a
// push completes, we just keep the latest op intent.
export const up = `
  CREATE TABLE IF NOT EXISTS sync_queue (
    id          TEXT PRIMARY KEY,
    table_name  TEXT NOT NULL,
    record_key  TEXT NOT NULL,
    operation   TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
    created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (table_name, record_key)
  );

  CREATE INDEX IF NOT EXISTS idx_sync_queue_created ON sync_queue(created_at);
`;

export const down = `DROP TABLE IF EXISTS sync_queue CASCADE;`;

export const up = `
CREATE TABLE IF NOT EXISTS browser_bookmarks (
  id         TEXT PRIMARY KEY,
  parent_id  TEXT REFERENCES browser_bookmarks(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('bookmark', 'folder')),
  title      TEXT NOT NULL DEFAULT '',
  url        TEXT,
  favicon    TEXT,
  position   DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (kind = 'folder' OR url IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS browser_bookmarks_parent ON browser_bookmarks(parent_id, position);
`;
export const down = `DROP TABLE IF EXISTS browser_bookmarks;`;

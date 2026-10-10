export const up = `
CREATE TABLE IF NOT EXISTS chat_artifacts (
  id         TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('markdown', 'html', 'code')),
  content    TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'working',
  is_open    BOOLEAN NOT NULL DEFAULT true,
  is_deleted BOOLEAN NOT NULL DEFAULT false,
  version    INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  language   TEXT,
  path       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS chat_artifacts_thread_name
  ON chat_artifacts (thread_id, LOWER(name));
CREATE INDEX IF NOT EXISTS chat_artifacts_thread_open
  ON chat_artifacts (thread_id, is_deleted, is_open, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_artifact_revisions (
  artifact_id TEXT NOT NULL REFERENCES chat_artifacts(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  content     TEXT NOT NULL,
  author      TEXT NOT NULL CHECK (author IN ('agent', 'human')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (artifact_id, version)
);
`;

export const down = `
DROP TABLE IF EXISTS chat_artifact_revisions;
DROP TABLE IF EXISTS chat_artifacts;
`;

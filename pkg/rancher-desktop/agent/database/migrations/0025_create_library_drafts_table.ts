export const up = `
  -- library_drafts — editable DB copies of library items (skills, functions,
  -- recipes) forked from the on-disk registry. Edits stay in the DB until
  -- the user publishes, at which point the draft is materialised back to
  -- ~/sulla/<kind>s/<slug>/ or submitted to the marketplace.
  --
  -- Polymorphic: one row per draft regardless of kind. The manifest JSON
  -- follows the sulla/v3 manifest shape; files_json carries the bundle's
  -- file contents as a path → string map (base64 for binary, UTF-8 for text).
  CREATE TABLE IF NOT EXISTS library_drafts (
    id            VARCHAR(255) PRIMARY KEY,
    kind          VARCHAR(32)  NOT NULL
                    CHECK (kind IN ('skill', 'function', 'recipe')),
    slug          VARCHAR(255) NOT NULL,
    base_slug     VARCHAR(255),              -- original on-disk slug, NULL when from-scratch
    name          VARCHAR(500) NOT NULL,
    manifest_json JSONB        NOT NULL,
    files_json    JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_library_drafts_kind    ON library_drafts(kind);
  CREATE INDEX IF NOT EXISTS idx_library_drafts_updated ON library_drafts(updated_at DESC);
`;

export const down = `
  DROP TABLE IF EXISTS library_drafts CASCADE;
`;

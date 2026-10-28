-- SPDX-License-Identifier: GPL-2.0-or-later
-- One operator-controlled namespace shared by File Manager and the agent mount.
-- Existing collection contents stay in place; explorer_path is only a reversible
-- presentation mapping, so no file, version, share, or native-source row moves.
ALTER TABLE collections ADD COLUMN IF NOT EXISTS explorer_path TEXT;

UPDATE collections
SET explorer_path = CASE
  WHEN is_default THEN ''
  ELSE regexp_replace(name, '[\\/]+', '-', 'g') || '--' || left(id::text, 8)
END
WHERE explorer_path IS NULL;

ALTER TABLE collections ALTER COLUMN explorer_path SET DEFAULT '';

DO $$ BEGIN
  ALTER TABLE collections ADD CONSTRAINT collections_explorer_path_safe CHECK (
    explorer_path = btrim(explorer_path) AND
    explorer_path !~ '(^/|/$|//|(^|/)\.\.?($|/)|\\)' AND
    lower(explorer_path) !~ '(^|/)(wallet|wallets|crypto-wallet|vault|vaults)($|/)'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS collections_explorer_path_owner_org
  ON collections(coalesce(org_id, ''), owner_user_id, explorer_path)
  WHERE published=TRUE AND legacy_source=FALSE;

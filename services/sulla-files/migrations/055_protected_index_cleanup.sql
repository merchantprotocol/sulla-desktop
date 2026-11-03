-- SPDX-License-Identifier: GPL-2.0-or-later
-- A protection insert can wait behind an indexer's file-row lock. Purging in
-- the same protection transaction guarantees that any rows committed by that
-- in-flight indexer are removed before protection becomes visible.
CREATE OR REPLACE FUNCTION purge_protected_file_search_index() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM file_search_text WHERE file_id=NEW.file_id;
  DELETE FROM file_search_chunks WHERE file_id=NEW.file_id;
  DELETE FROM file_index_jobs WHERE file_id=NEW.file_id;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_purge_protected_file_search_index
  AFTER INSERT OR UPDATE OF file_id ON files_protected_files
  FOR EACH ROW EXECUTE FUNCTION purge_protected_file_search_index();

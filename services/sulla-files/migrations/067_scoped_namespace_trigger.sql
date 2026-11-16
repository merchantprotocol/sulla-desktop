-- SPDX-License-Identifier: GPL-2.0-or-later
-- Let path-scoped creates in one collection run side by side.
--
-- 027 made every file/folder INSERT (and path change) take the collection's
-- 'stored-namespace:<id>' advisory key EXCLUSIVELY, so every create in a
-- collection queued behind the previous one until it committed. The app's
-- path-scoped gate (StoredNamespaceGuard.lock with a path) already holds the
-- locks that make that row safe: the collection key SHARED (which excludes
-- broad renames/moves/deletes and unscoped writers, both exclusive), every
-- ancestor slot SHARED and the target slot EXCLUSIVE. Taking the collection
-- key exclusively again here also upgraded a shared lock and deadlocked two
-- concurrent creates, which is why 33378a49d made the app take it exclusively.
--
-- The app now records each scope it holds in the transaction-local setting
-- 'sulla_files.namespace_scopes' ("<collection id>:<path>", newline
-- separated). A row at a declared scope path, or a folder at one of its
-- ancestors (the parent folders the create inserts, whose slots the app holds
-- shared), is already covered, so the trigger takes no lock for it. Every
-- other row keeps the 027 behaviour: the exclusive collection key. The occupancy checks run unchanged for every row.
CREATE OR REPLACE FUNCTION files_guard_operation_namespace() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE cid UUID; p TEXT; own UUID; covered BOOLEAN;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.collection_id,NEW.path) IS NOT DISTINCT FROM (OLD.collection_id,OLD.path) THEN RETURN NEW; END IF;
  cid:=NEW.collection_id; p:=NEW.path;
  SELECT EXISTS(SELECT 1 FROM unnest(string_to_array(COALESCE(current_setting('sulla_files.namespace_scopes',TRUE),''),E'\n')) AS s(scope)
    WHERE s.scope=cid::text||':'||p OR (TG_TABLE_NAME='file_folders' AND starts_with(s.scope,cid::text||':'||p||'/'))) INTO covered;
  IF NOT covered THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('stored-namespace:'||cid,0));
  END IF;
  IF TG_TABLE_NAME='files' THEN
    own:=NEW.id;
    IF EXISTS(SELECT 1 FROM file_folders WHERE collection_id=cid AND (path=p OR starts_with(path,p||'/'))) THEN
      RAISE EXCEPTION 'Folder occupies file destination' USING ERRCODE='23505';
    END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM files WHERE collection_id=cid AND (own IS NULL OR id<>own)
    AND (path=p OR starts_with(p,path||'/') OR (TG_TABLE_NAME='files' AND starts_with(path,p||'/')))) THEN
    RAISE EXCEPTION 'File occupies namespace destination' USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END $$;

-- Per-collection, path-scoped FUSE invalidation events. Inserts do not lock
-- shared tree-revision rows, so unrelated collection writes remain independent.
CREATE TABLE fuse_change_journal (
  id BIGSERIAL PRIMARY KEY,
  xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  collection_id UUID NOT NULL,
  path TEXT NOT NULL,
  old_path TEXT,
  kind TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX fuse_change_journal_collection_id_id ON fuse_change_journal(collection_id, id);
CREATE TABLE fuse_change_retention (
  collection_id UUID PRIMARY KEY,
  pruned_through BIGINT NOT NULL
);

CREATE OR REPLACE FUNCTION record_fuse_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_row jsonb; new_row jsonb; old_collection uuid; new_collection uuid;
        old_path text; new_path text; changed boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_row := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN new_row := to_jsonb(NEW); END IF;
  old_collection := CASE WHEN old_row IS NULL THEN NULL ELSE (old_row->>'collection_id')::uuid END;
  new_collection := CASE WHEN new_row IS NULL THEN NULL ELSE (new_row->>'collection_id')::uuid END;
  old_path := old_row->>'path'; new_path := new_row->>'path';
  IF TG_OP = 'UPDATE' THEN
    changed := old_collection IS DISTINCT FROM new_collection OR old_path IS DISTINCT FROM new_path
      OR old_row->>'current_version_id' IS DISTINCT FROM new_row->>'current_version_id'
      OR old_row->>'deleted_at' IS DISTINCT FROM new_row->>'deleted_at'
      OR old_row->>'size' IS DISTINCT FROM new_row->>'size';
    IF NOT changed THEN RETURN NULL; END IF;
  END IF;
  IF old_collection IS NOT NULL AND old_collection IS DISTINCT FROM new_collection THEN
    INSERT INTO fuse_change_journal(collection_id,path,old_path,kind)
      VALUES(old_collection,old_path,NULL,lower(TG_OP));
  END IF;
  IF new_collection IS NOT NULL THEN
    INSERT INTO fuse_change_journal(collection_id,path,old_path,kind)
      VALUES(new_collection,new_path,CASE WHEN old_collection=new_collection AND old_path IS DISTINCT FROM new_path THEN old_path ELSE NULL END,
        CASE WHEN TG_OP='UPDATE' AND old_path IS DISTINCT FROM new_path THEN 'rename' ELSE lower(TG_OP) END);
  ELSIF old_collection IS NOT NULL THEN
    INSERT INTO fuse_change_journal(collection_id,path,old_path,kind) VALUES(old_collection,old_path,NULL,lower(TG_OP));
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER files_fuse_change AFTER INSERT OR UPDATE OR DELETE ON files
  FOR EACH ROW EXECUTE FUNCTION record_fuse_change();
CREATE TRIGGER folders_fuse_change AFTER INSERT OR UPDATE OR DELETE ON file_folders
  FOR EACH ROW EXECUTE FUNCTION record_fuse_change();

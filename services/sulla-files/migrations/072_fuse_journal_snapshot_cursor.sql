ALTER TABLE fuse_change_journal ADD COLUMN current_version_id UUID;
ALTER TABLE fuse_change_journal ADD COLUMN size BIGINT;
CREATE INDEX fuse_change_journal_collection_xid ON fuse_change_journal(collection_id,xid);
ALTER TABLE fuse_change_retention ADD COLUMN pruned_xid xid8;

CREATE OR REPLACE FUNCTION record_fuse_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_row jsonb; new_row jsonb; old_collection uuid; new_collection uuid;
        old_path text; new_path text; changed boolean; event_kind text; row_data jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_row := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN new_row := to_jsonb(NEW); END IF;
  old_collection := CASE WHEN old_row IS NULL THEN NULL ELSE (old_row->>'collection_id')::uuid END;
  new_collection := CASE WHEN new_row IS NULL THEN NULL ELSE (new_row->>'collection_id')::uuid END;
  old_path := old_row->>'path'; new_path := new_row->>'path';
  IF TG_OP = 'UPDATE' THEN
    changed := old_collection IS DISTINCT FROM new_collection OR old_path IS DISTINCT FROM new_path
      OR old_row->>'current_version_id' IS DISTINCT FROM new_row->>'current_version_id'
      OR old_row->>'deleted_at' IS DISTINCT FROM new_row->>'deleted_at' OR old_row->>'size' IS DISTINCT FROM new_row->>'size';
    IF NOT changed THEN RETURN NULL; END IF;
  END IF;
  IF old_collection IS NOT NULL AND old_collection IS DISTINCT FROM new_collection THEN
    INSERT INTO fuse_change_journal(collection_id,path,kind,current_version_id,size)
      VALUES(old_collection,old_path,'delete',(old_row->>'current_version_id')::uuid,(old_row->>'size')::bigint);
  END IF;
  IF new_collection IS NOT NULL THEN
    event_kind := CASE WHEN TG_OP='UPDATE' AND old_path IS DISTINCT FROM new_path THEN 'rename'
      WHEN TG_OP='UPDATE' AND old_row->>'deleted_at' IS NULL AND new_row->>'deleted_at' IS NOT NULL THEN 'delete'
      WHEN TG_OP='UPDATE' AND old_row->>'deleted_at' IS NOT NULL AND new_row->>'deleted_at' IS NULL THEN 'insert'
      WHEN TG_OP='UPDATE' THEN 'update' ELSE lower(TG_OP) END;
    row_data := CASE WHEN TG_OP='DELETE' THEN old_row ELSE new_row END;
    INSERT INTO fuse_change_journal(collection_id,path,old_path,kind,current_version_id,size)
      VALUES(new_collection,new_path,CASE WHEN old_collection=new_collection AND old_path IS DISTINCT FROM new_path THEN old_path ELSE NULL END,
      event_kind,(row_data->>'current_version_id')::uuid,(row_data->>'size')::bigint);
  ELSIF old_collection IS NOT NULL THEN
    INSERT INTO fuse_change_journal(collection_id,path,kind,current_version_id,size)
      VALUES(old_collection,old_path,'delete',(old_row->>'current_version_id')::uuid,(old_row->>'size')::bigint);
  END IF;
  RETURN NULL;
END $$;

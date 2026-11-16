-- Direct-child keyset pagination for the FUSE v2 API.
ALTER TABLE files ADD COLUMN IF NOT EXISTS parent_path text GENERATED ALWAYS AS (CASE WHEN position('/' in path)=0 THEN '' ELSE regexp_replace(path,'/[^/]*$','') END) STORED;
ALTER TABLE file_folders ADD COLUMN IF NOT EXISTS parent_path text GENERATED ALWAYS AS (CASE WHEN position('/' in path)=0 THEN '' ELSE regexp_replace(path,'/[^/]*$','') END) STORED;
CREATE INDEX IF NOT EXISTS files_fuse_parent_path ON files(collection_id,parent_path,path) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS file_folders_fuse_parent_path ON file_folders(collection_id,parent_path,path) WHERE deleted_at IS NULL;

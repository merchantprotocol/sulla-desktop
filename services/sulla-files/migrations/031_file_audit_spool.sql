-- SPDX-License-Identifier: GPL-2.0-or-later
-- Durable delivery queue. Events survive service crashes and log-append failures.
CREATE TABLE IF NOT EXISTS files_audit_spool (
  id BIGSERIAL PRIMARY KEY,
  event JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT
);

CREATE OR REPLACE FUNCTION files_capture_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subject files%ROWTYPE; operation TEXT; actor TEXT; request_id TEXT;
BEGIN
  IF TG_OP='DELETE' THEN subject:=OLD; ELSE subject:=NEW; END IF;
  -- Logs never audit themselves. Protected identities and paths never enter logs.
  IF EXISTS(SELECT 1 FROM collections WHERE id=subject.collection_id AND system_area='logs')
    OR EXISTS(SELECT 1 FROM files_protected_files WHERE file_id=subject.id)
    OR lower(subject.path) ~ '(^|/)(master[.]key|wallet|wallets|crypto-wallet|vault|vaults)($|/)'
    THEN RETURN NULL; END IF;
  IF TG_OP='INSERT' THEN operation:='create';
  ELSIF TG_OP='DELETE' THEN operation:='delete';
  ELSIF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN operation:='trash';
  ELSIF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN operation:='restore';
  ELSIF OLD.collection_id IS DISTINCT FROM NEW.collection_id THEN operation:='move';
  ELSIF OLD.path IS DISTINCT FROM NEW.path THEN operation:='rename';
  ELSIF OLD.current_version_id IS DISTINCT FROM NEW.current_version_id THEN operation:='write';
  ELSE RETURN NULL; END IF;
  actor:=coalesce(nullif(current_setting('sulla.audit_actor',true),''),'sulla-files');
  request_id:=coalesce(current_setting('sulla.audit_request_id',true),'');
  IF current_setting('sulla.audit_action',true)='restore' AND operation='write' THEN operation:='restore'; END IF;
  IF current_setting('sulla.audit_action',true)='copy' AND operation='create' THEN operation:='copy'; END IF;
  INSERT INTO files_audit_spool(event) VALUES(jsonb_build_object(
    'ts',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'actor',actor,'action',operation,'subjectKind','file','subjectId',subject.id::text,
    'path',subject.path,'result','success','requestId',request_id));
  RETURN NULL;
END $$;

CREATE TRIGGER files_audit_changes AFTER INSERT OR UPDATE OR DELETE ON files
  FOR EACH ROW EXECUTE FUNCTION files_capture_change();

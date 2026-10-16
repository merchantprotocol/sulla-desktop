CREATE TABLE IF NOT EXISTS user_item_changes (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  change_seq bigint NOT NULL,
  PRIMARY KEY (user_id, item_id)
);
CREATE INDEX IF NOT EXISTS user_item_changes_seq_idx ON user_item_changes(user_id, change_seq);

CREATE OR REPLACE FUNCTION vault_mark_collection_for_user(p_user_id uuid, p_collection_id uuid)
RETURNS void AS $$
  INSERT INTO user_item_changes(user_id, item_id, change_seq)
  SELECT p_user_id, i.id, nextval('items_change_seq_seq')
    FROM items i
   WHERE i.collection_id = p_collection_id
  ON CONFLICT (user_id, item_id) DO UPDATE SET change_seq = EXCLUDED.change_seq;
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION vault_collection_member_sync_grant() RETURNS trigger AS $$
BEGIN
  IF NEW.can_view AND (TG_OP = 'INSERT' OR NOT OLD.can_view) THEN
    PERFORM vault_mark_collection_for_user(NEW.user_id, NEW.collection_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS collection_member_sync_grant ON collection_members;
CREATE TRIGGER collection_member_sync_grant
  AFTER INSERT OR UPDATE ON collection_members
  FOR EACH ROW EXECUTE FUNCTION vault_collection_member_sync_grant();

CREATE OR REPLACE FUNCTION vault_group_member_sync_grant() RETURNS trigger AS $$
DECLARE collection record;
BEGIN
  FOR collection IN
    SELECT collection_id FROM collection_group_members
     WHERE group_id = NEW.group_id AND can_view
  LOOP
    PERFORM vault_mark_collection_for_user(NEW.user_id, collection.collection_id);
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS group_member_sync_grant ON group_members;
CREATE TRIGGER group_member_sync_grant
  AFTER INSERT ON group_members
  FOR EACH ROW EXECUTE FUNCTION vault_group_member_sync_grant();

CREATE OR REPLACE FUNCTION vault_collection_group_sync_grant() RETURNS trigger AS $$
DECLARE member record;
BEGIN
  IF NEW.can_view AND (TG_OP = 'INSERT' OR NOT OLD.can_view) THEN
    FOR member IN SELECT user_id FROM group_members WHERE group_id = NEW.group_id LOOP
      PERFORM vault_mark_collection_for_user(member.user_id, NEW.collection_id);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS collection_group_sync_grant ON collection_group_members;
CREATE TRIGGER collection_group_sync_grant
  AFTER INSERT OR UPDATE ON collection_group_members
  FOR EACH ROW EXECUTE FUNCTION vault_collection_group_sync_grant();

CREATE OR REPLACE FUNCTION vault_org_member_sync_grant() RETURNS trigger AS $$
DECLARE collection record;
BEGIN
  IF NEW.status = 'confirmed' AND
     (TG_OP = 'INSERT' OR OLD.status <> 'confirmed' OR OLD.role IS DISTINCT FROM NEW.role) THEN
    FOR collection IN
      SELECT c.id
        FROM collections c
        LEFT JOIN collection_members cm ON cm.collection_id = c.id AND cm.user_id = NEW.user_id
       WHERE c.org_id = NEW.org_id
         AND (NEW.role IN ('owner', 'admin') OR cm.can_view OR EXISTS (
           SELECT 1 FROM group_members gm
           JOIN collection_group_members cgm ON cgm.group_id = gm.group_id
          WHERE gm.user_id = NEW.user_id AND cgm.collection_id = c.id AND cgm.can_view))
    LOOP
      PERFORM vault_mark_collection_for_user(NEW.user_id, collection.id);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS org_member_sync_grant ON org_members;
CREATE TRIGGER org_member_sync_grant
  AFTER INSERT OR UPDATE ON org_members
  FOR EACH ROW EXECUTE FUNCTION vault_org_member_sync_grant();

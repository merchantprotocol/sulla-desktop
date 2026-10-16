ALTER TABLE orgs ADD COLUMN IF NOT EXISTS recovery_public_key text;
ALTER TABLE items ADD COLUMN IF NOT EXISTS change_seq bigint;
CREATE SEQUENCE IF NOT EXISTS items_change_seq_seq;
ALTER TABLE items ALTER COLUMN change_seq SET DEFAULT nextval('items_change_seq_seq');
UPDATE items SET change_seq = nextval('items_change_seq_seq') WHERE change_seq IS NULL;
ALTER TABLE items ALTER COLUMN change_seq SET NOT NULL;

CREATE OR REPLACE FUNCTION vault_items_change_seq() RETURNS trigger AS $$
BEGIN
  NEW.change_seq := nextval('items_change_seq_seq');
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS items_change_seq ON items;
CREATE TRIGGER items_change_seq BEFORE INSERT OR UPDATE ON items
FOR EACH ROW EXECUTE FUNCTION vault_items_change_seq();

CREATE INDEX IF NOT EXISTS items_change_seq_idx ON items(change_seq);

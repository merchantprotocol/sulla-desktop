ALTER TABLE orgs ADD COLUMN IF NOT EXISTS encrypted_join_org_key jsonb;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS join_kdf jsonb;

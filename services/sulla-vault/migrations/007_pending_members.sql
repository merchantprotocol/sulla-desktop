UPDATE orgs SET encrypted_join_org_key = NULL, join_kdf = NULL
WHERE encrypted_join_org_key IS NOT NULL OR join_kdf IS NOT NULL;

ALTER TABLE org_members ALTER COLUMN wrapped_org_key DROP NOT NULL;
ALTER TABLE org_members ADD COLUMN IF NOT EXISTS status text;
UPDATE org_members SET status = 'confirmed' WHERE status IS NULL;
ALTER TABLE org_members ALTER COLUMN status SET DEFAULT 'confirmed';
ALTER TABLE org_members ALTER COLUMN status SET NOT NULL;
ALTER TABLE org_members DROP CONSTRAINT IF EXISTS org_members_status_check;
ALTER TABLE org_members ADD CONSTRAINT org_members_status_check CHECK (status IN ('pending', 'confirmed'));

ALTER TABLE orgs ADD COLUMN IF NOT EXISTS auto_confirm_new_members boolean NOT NULL DEFAULT false;

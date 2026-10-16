ALTER TABLE orgs ADD COLUMN IF NOT EXISTS join_password_salt bytea;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS join_password_verifier bytea;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS recovery_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS blocked boolean NOT NULL DEFAULT false;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS reason text;

CREATE TABLE IF NOT EXISTS org_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  encrypted_name jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id uuid NOT NULL REFERENCES org_groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE IF NOT EXISTS collection_group_members (
  collection_id uuid NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES org_groups(id) ON DELETE CASCADE,
  can_view boolean NOT NULL DEFAULT false,
  can_use_by_agents boolean NOT NULL DEFAULT false,
  can_edit boolean NOT NULL DEFAULT false,
  can_manage boolean NOT NULL DEFAULT false,
  PRIMARY KEY (collection_id, group_id),
  CHECK (NOT can_use_by_agents OR can_view), CHECK (NOT can_edit OR can_view), CHECK (NOT can_manage OR can_view)
);
CREATE TABLE IF NOT EXISTS org_recovery_keys (
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wrapped_user_key jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS audit_log_org_created_idx ON audit_log(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_created_idx ON audit_log(actor_user_id, created_at DESC);

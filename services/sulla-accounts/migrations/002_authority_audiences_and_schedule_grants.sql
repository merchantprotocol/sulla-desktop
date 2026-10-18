ALTER TABLE accounts.authorities ADD COLUMN resource_audiences text[] NOT NULL DEFAULT '{}';
UPDATE accounts.authorities SET resource_audiences = ARRAY[audience] WHERE audience <> '';
ALTER TABLE accounts.authorities DROP COLUMN audience;

CREATE TABLE accounts.delegated_schedule_grants (
  id uuid PRIMARY KEY,
  token_digest bytea NOT NULL UNIQUE,
  service_id text NOT NULL,
  authority_id uuid NOT NULL REFERENCES accounts.authorities(id) ON DELETE CASCADE,
  issuer text NOT NULL,
  subject text NOT NULL,
  organization_id uuid NOT NULL,
  audience text NOT NULL,
  workflow_id text NOT NULL,
  schedule_node_id text NOT NULL,
  required_roles text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX delegated_schedule_grants_active_idx
  ON accounts.delegated_schedule_grants(service_id, expires_at)
  WHERE revoked_at IS NULL;

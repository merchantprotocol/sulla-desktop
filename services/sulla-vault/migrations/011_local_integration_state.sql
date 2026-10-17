CREATE TABLE IF NOT EXISTS local_integration_state (
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  integration_id text NOT NULL,
  active_account_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, integration_id)
);

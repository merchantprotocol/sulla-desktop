CREATE SCHEMA IF NOT EXISTS accounts;

CREATE TABLE IF NOT EXISTS accounts.accounts_schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts.local_profile (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  id uuid NOT NULL UNIQUE,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts.authorities (
  id uuid PRIMARY KEY,
  issuer text NOT NULL UNIQUE,
  client_id text NOT NULL,
  audience text NOT NULL,
  scopes text[] NOT NULL,
  authorization_endpoint text NOT NULL,
  token_endpoint text NOT NULL,
  jwks_uri text NOT NULL,
  revocation_endpoint text,
  membership_endpoint text,
  subject text,
  connected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts.authority_sessions (
  authority_id uuid PRIMARY KEY REFERENCES accounts.authorities(id) ON DELETE CASCADE,
  envelope_version integer NOT NULL DEFAULT 1 CHECK (envelope_version = 1),
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL,
  auth_tag bytea NOT NULL,
  access_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts.authorization_transactions (
  id uuid PRIMARY KEY,
  authority_id uuid NOT NULL REFERENCES accounts.authorities(id) ON DELETE CASCADE,
  state_digest bytea NOT NULL UNIQUE,
  verifier_ciphertext bytea NOT NULL,
  verifier_nonce bytea NOT NULL,
  verifier_auth_tag bytea NOT NULL,
  nonce text NOT NULL,
  redirect_uri text NOT NULL,
  return_to text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS authorization_transactions_expiry_idx
  ON accounts.authorization_transactions(expires_at);

CREATE TABLE IF NOT EXISTS accounts.memberships (
  id uuid PRIMARY KEY,
  issuer text NOT NULL,
  subject text NOT NULL,
  organization_id uuid NOT NULL,
  roles text[] NOT NULL DEFAULT '{}',
  groups text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (issuer, subject, organization_id)
);

CREATE INDEX IF NOT EXISTS memberships_identity_idx
  ON accounts.memberships(issuer, subject, organization_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS accounts.membership_cache (
  authority_id uuid NOT NULL REFERENCES accounts.authorities(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  roles text[] NOT NULL DEFAULT '{}',
  groups text[] NOT NULL DEFAULT '{}',
  source_updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (authority_id, organization_id)
);

CREATE TABLE IF NOT EXISTS accounts.broker_sessions (
  jti_digest bytea PRIMARY KEY,
  profile_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS broker_sessions_expiry_idx ON accounts.broker_sessions(expires_at);
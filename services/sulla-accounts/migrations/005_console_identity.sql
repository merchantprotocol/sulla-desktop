CREATE TABLE accounts.organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE accounts.memberships
  ADD CONSTRAINT memberships_organization_fk
  FOREIGN KEY (organization_id) REFERENCES accounts.organizations(id) ON DELETE CASCADE
  NOT VALID;

CREATE TABLE accounts.web_authorization_transactions (
  id uuid PRIMARY KEY,
  state_digest bytea NOT NULL UNIQUE,
  browser_binding_digest bytea NOT NULL,
  verifier_ciphertext bytea NOT NULL,
  verifier_nonce bytea NOT NULL,
  verifier_auth_tag bytea NOT NULL,
  nonce text NOT NULL,
  return_to text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX web_authorization_transactions_expiry_idx
  ON accounts.web_authorization_transactions(expires_at);

CREATE TABLE accounts.web_sessions (
  id uuid PRIMARY KEY,
  token_digest bytea NOT NULL UNIQUE,
  csrf_digest bytea NOT NULL,
  issuer text NOT NULL,
  subject text NOT NULL,
  access_ciphertext bytea NOT NULL,
  access_nonce bytea NOT NULL,
  access_auth_tag bytea NOT NULL,
  access_expires_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX web_sessions_identity_idx
  ON accounts.web_sessions(issuer, subject, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE accounts.ui_sessions (
  id uuid PRIMARY KEY,
  token_digest bytea NOT NULL UNIQUE,
  web_session_id uuid NOT NULL REFERENCES accounts.web_sessions(id) ON DELETE CASCADE,
  service_id text NOT NULL,
  audience text NOT NULL,
  issuer text NOT NULL,
  subject text NOT NULL,
  authority_id uuid NOT NULL REFERENCES accounts.authorities(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES accounts.organizations(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ui_sessions_active_idx
  ON accounts.ui_sessions(service_id, audience, expires_at) WHERE revoked_at IS NULL;

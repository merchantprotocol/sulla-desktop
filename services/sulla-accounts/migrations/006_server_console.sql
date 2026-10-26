-- SPDX-License-Identifier: LicenseRef-Sulla-Fair-Code
CREATE TABLE accounts.server_limits (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  seat_limit integer NOT NULL DEFAULT 25 CHECK (seat_limit > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO accounts.server_limits(singleton, seat_limit) VALUES (true, 25) ON CONFLICT DO NOTHING;

CREATE TABLE accounts.invitations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES accounts.organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  roles text[] NOT NULL DEFAULT ARRAY['member']::text[],
  token_digest bytea NOT NULL UNIQUE,
  invited_by_subject text NOT NULL,
  keycloak_user_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX invitations_pending_email_idx ON accounts.invitations(organization_id, lower(email)) WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE accounts.desktop_enrollments (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES accounts.organizations(id) ON DELETE CASCADE,
  issuer text NOT NULL,
  subject text NOT NULL,
  device_id text NOT NULL,
  public_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  poll_token_digest bytea NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','expired')),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, device_id)
);

CREATE TABLE accounts.desktop_devices (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES accounts.organizations(id) ON DELETE CASCADE,
  issuer text NOT NULL,
  subject text NOT NULL,
  device_id text NOT NULL,
  public_key text NOT NULL,
  name text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  last_heartbeat_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, device_id)
);

CREATE TABLE accounts.desktop_relay_tickets (
  jti_digest bytea PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES accounts.desktop_devices(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- SPDX-License-Identifier: GPL-2.0-or-later
-- Server-mode vault origin (/cloud-vault-sync/*) and the server-providers system collection.
-- Every row holds ciphertext, hashes, counters or ids. No plaintext item, key or password ever lands here.

-- One org vault per Vault organization. Its id is the vaultId every sync envelope is bound to.
CREATE TABLE IF NOT EXISTS browser_sync_vaults (
  vault_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL UNIQUE REFERENCES orgs(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Each member's sync bundle: their own wrapped user key, key pair and KDF parameters, MAC'd by
-- their browser. The server checks it matches the account's stored wrapped keys byte for byte.
CREATE TABLE IF NOT EXISTS browser_sync_bundles (
  vault_id          uuid NOT NULL REFERENCES browser_sync_vaults(vault_id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  epoch             integer NOT NULL CHECK (epoch >= 1),
  bundle_generation integer NOT NULL CHECK (bundle_generation >= 1),
  bundle            jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vault_id, user_id)
);

-- Signed manifest head per scope. scope_owner is the member's user id for their personal scope,
-- or the collection id for a shared collection scope.
CREATE TABLE IF NOT EXISTS browser_sync_heads (
  vault_id    uuid NOT NULL REFERENCES browser_sync_vaults(vault_id) ON DELETE CASCADE,
  scope_owner uuid NOT NULL,
  scope       text NOT NULL CHECK (scope = 'personal' OR scope = scope_owner::text),
  seq         bigint NOT NULL CHECK (seq >= 1),
  head        jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vault_id, scope_owner)
);

-- Opaque sync records (item ciphertext or tombstones), with the counters the server enforces.
CREATE TABLE IF NOT EXISTS browser_sync_records (
  vault_id    uuid NOT NULL,
  scope_owner uuid NOT NULL,
  id          uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('item', 'folder')),
  generation  bigint NOT NULL CHECK (generation >= 1),
  deleted     boolean NOT NULL,
  seq         bigint NOT NULL,
  size_bytes  integer NOT NULL,
  record      jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vault_id, scope_owner, id),
  FOREIGN KEY (vault_id, scope_owner) REFERENCES browser_sync_heads(vault_id, scope_owner) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS browser_sync_records_seq_idx ON browser_sync_records(vault_id, scope_owner, seq, id);

-- One-time handoff codes from the console (60 seconds, single use). Only the SHA-256 is stored.
CREATE TABLE IF NOT EXISTS browser_sync_handoffs (
  code_hash  text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  org_label  text CHECK (org_label IS NULL OR length(org_label) <= 120),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Vault-origin browser sessions behind the __Host-sulla_vault cookie. Only the token's SHA-256 is stored.
CREATE TABLE IF NOT EXISTS browser_sync_sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  org_label  text CHECK (org_label IS NULL OR length(org_label) <= 120),
  ip_hash    text,
  ua_hash    text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS browser_sync_sessions_user_idx ON browser_sync_sessions(user_id, org_id);

-- The server-providers system collection: model provider keys sealed (X25519 sealed box) to the
-- Agents broker's public key. Vault can't open them; only the Agents service holds the private key.
-- Non-secret provider settings (models, defaults, a display hint) live in the console's own database.
CREATE TABLE IF NOT EXISTS server_provider_credentials (
  org_id                uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  provider              text NOT NULL CHECK (provider ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  sealed_credential     jsonb NOT NULL,
  recipient_fingerprint text NOT NULL,
  revision              bigint NOT NULL DEFAULT 1,
  updated_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, provider)
);

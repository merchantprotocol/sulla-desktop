-- Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
-- Licensed under the Sulla Fair-Code License. See LICENSE.

CREATE TABLE IF NOT EXISTS sulla_console.user_prefs (
  issuer text NOT NULL,
  subject text NOT NULL,
  active_org uuid,
  timezone text,
  colour text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, subject)
);
CREATE TABLE IF NOT EXISTS sulla_console.conversations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  issuer text NOT NULL,
  subject text NOT NULL,
  title text NOT NULL DEFAULT 'New chat',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sulla_console.messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES sulla_console.conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user','assistant','system')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sulla_console.audit_events (
  id uuid PRIMARY KEY,
  organization_id uuid,
  issuer text NOT NULL,
  subject text NOT NULL,
  kind text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_scope_idx ON sulla_console.conversations(organization_id, issuer, subject, updated_at DESC);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON sulla_console.messages(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS sulla_console.usage_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  subject text,
  source text NOT NULL,
  model text,
  provider text,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  duration_ms bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sulla_console.usage_settings (
  organization_id uuid PRIMARY KEY,
  monthly_token_cap bigint,
  action text NOT NULL DEFAULT 'block' CHECK (action IN ('block','ask')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sulla_console.usecase_installs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  template_id text NOT NULL,
  version text,
  target text NOT NULL DEFAULT 'server',
  status text NOT NULL,
  installed_by text NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, template_id, target)
);
CREATE INDEX IF NOT EXISTS usage_events_scope_idx ON sulla_console.usage_events(organization_id, created_at DESC);

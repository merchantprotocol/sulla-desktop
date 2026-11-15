// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export const up = `
  CREATE TABLE IF NOT EXISTS org_messaging_outbox (
    message_id TEXT PRIMARY KEY,
    envelope JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS org_messaging_outbox_pending_idx ON org_messaging_outbox(created_at,message_id) WHERE sent_at IS NULL;
  CREATE TABLE IF NOT EXISTS org_messaging_inbox_cursors (
    org_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    since BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(org_id,user_id)
  );
`;

export const down = `
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM org_messaging_outbox WHERE sent_at IS NULL)
      OR EXISTS (SELECT 1 FROM org_messaging_inbox_cursors WHERE since > 0) THEN
      RAISE EXCEPTION 'Cannot remove org messaging state while unsent messages or an inbox cursor exist';
    END IF;
  END $$;
  DROP TABLE IF EXISTS org_messaging_outbox;
  DROP TABLE IF EXISTS org_messaging_inbox_cursors;
`;

// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Denied outbox items stop retrying (failed_at + reason), and the last time the
// human was asked about a held first-contact sender is durable so re-asks are
// throttled across restarts.
export const up = `
  ALTER TABLE org_messaging_outbox ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;
  ALTER TABLE org_messaging_outbox ADD COLUMN IF NOT EXISTS failure_reason TEXT;
  DROP INDEX IF EXISTS org_messaging_outbox_pending_idx;
  CREATE INDEX IF NOT EXISTS org_messaging_outbox_pending_idx ON org_messaging_outbox(created_at,message_id) WHERE sent_at IS NULL AND failed_at IS NULL;
  CREATE TABLE IF NOT EXISTS org_messaging_contact_prompts (
    org_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    sender_user_id TEXT NOT NULL,
    last_asked_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY(org_id,user_id,sender_user_id)
  );
`;

export const down = `
  DROP TABLE IF EXISTS org_messaging_contact_prompts;
  DROP INDEX IF EXISTS org_messaging_outbox_pending_idx;
  CREATE INDEX IF NOT EXISTS org_messaging_outbox_pending_idx ON org_messaging_outbox(created_at,message_id) WHERE sent_at IS NULL;
  ALTER TABLE org_messaging_outbox DROP COLUMN IF EXISTS failure_reason;
  ALTER TABLE org_messaging_outbox DROP COLUMN IF EXISTS failed_at;
`;

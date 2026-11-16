// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Desktop now syncs every organization the human belongs to, each with its own
// outbox. The same message id may legitimately exist in two organizations, so the
// outbox is keyed by (org_id, message_id). Existing rows take their org from the
// stored envelope. Cursors and contact-prompt throttles were already org-keyed.
export const up = `
  ALTER TABLE org_messaging_outbox ADD COLUMN IF NOT EXISTS org_id TEXT;
  UPDATE org_messaging_outbox SET org_id = COALESCE(envelope->>'orgId', '') WHERE org_id IS NULL;
  ALTER TABLE org_messaging_outbox ALTER COLUMN org_id SET NOT NULL;
  ALTER TABLE org_messaging_outbox DROP CONSTRAINT IF EXISTS org_messaging_outbox_pkey;
  ALTER TABLE org_messaging_outbox ADD CONSTRAINT org_messaging_outbox_pkey PRIMARY KEY (org_id, message_id);
  DROP INDEX IF EXISTS org_messaging_outbox_pending_idx;
  CREATE INDEX IF NOT EXISTS org_messaging_outbox_pending_idx ON org_messaging_outbox(org_id, created_at, message_id) WHERE sent_at IS NULL AND failed_at IS NULL;
`;

export const down = `
  DO $$ BEGIN
    IF EXISTS (SELECT message_id FROM org_messaging_outbox GROUP BY message_id HAVING COUNT(*) > 1) THEN
      RAISE EXCEPTION 'Cannot remove org scoping while the same message id exists in more than one organization';
    END IF;
  END $$;
  DROP INDEX IF EXISTS org_messaging_outbox_pending_idx;
  ALTER TABLE org_messaging_outbox DROP CONSTRAINT IF EXISTS org_messaging_outbox_pkey;
  ALTER TABLE org_messaging_outbox ADD CONSTRAINT org_messaging_outbox_pkey PRIMARY KEY (message_id);
  ALTER TABLE org_messaging_outbox DROP COLUMN IF EXISTS org_id;
  CREATE INDEX IF NOT EXISTS org_messaging_outbox_pending_idx ON org_messaging_outbox(created_at, message_id) WHERE sent_at IS NULL AND failed_at IS NULL;
`;

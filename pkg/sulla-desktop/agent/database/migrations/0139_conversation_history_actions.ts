// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Stable action fields shared by Desktop, mobile, and Cloud projections. */
export const up = `
  ALTER TABLE conversation_history
    ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;

  ALTER TABLE claude_conversations
    ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;

  UPDATE conversation_history
  SET archived = TRUE, status = 'closed'
  WHERE status = 'archived';

  CREATE INDEX IF NOT EXISTS idx_conv_history_visible_order
    ON conversation_history (archived, pinned DESC, last_active_at DESC)
    WHERE deleted_at IS NULL AND hidden = FALSE;
`;

export const down = `
  DROP INDEX IF EXISTS idx_conv_history_visible_order;
  ALTER TABLE conversation_history DROP COLUMN IF EXISTS archived;
  ALTER TABLE claude_conversations DROP COLUMN IF EXISTS pinned, DROP COLUMN IF EXISTS archived;
`;

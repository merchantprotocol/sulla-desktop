// SPDX-License-Identifier: GPL-2.0-or-later

export const up = `
  ALTER TABLE claude_messages ADD COLUMN IF NOT EXISTS relay_history_pending JSONB;
  CREATE INDEX IF NOT EXISTS claude_messages_relay_history_pending
    ON claude_messages (contractor_id, id) WHERE relay_history_pending IS NOT NULL AND deleted_at IS NULL;
`;
export const down = '';

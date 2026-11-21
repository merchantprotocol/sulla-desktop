// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.


export const up = `
  ALTER TABLE claude_messages ADD COLUMN IF NOT EXISTS relay_terminal_pending JSONB;
  CREATE INDEX IF NOT EXISTS claude_messages_relay_terminal_pending_idx
    ON claude_messages (contractor_id, id) WHERE relay_terminal_pending IS NOT NULL AND deleted_at IS NULL;
`;

// Keep additive outbox metadata intact across a pilot rollback.
export const down = '';

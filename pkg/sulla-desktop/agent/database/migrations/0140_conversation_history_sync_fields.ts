// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Pin/archive timestamps, unread count and updated_at for mobile sync (last-writer-wins). */
export const up = `
  ALTER TABLE conversation_history
    ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS unread_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP;
`;

export const down = `
  ALTER TABLE conversation_history
    DROP COLUMN IF EXISTS pinned_at,
    DROP COLUMN IF EXISTS archived_at,
    DROP COLUMN IF EXISTS unread_count,
    DROP COLUMN IF EXISTS updated_at;
`;

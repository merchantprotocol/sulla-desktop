// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export const up = `
  CREATE TABLE IF NOT EXISTS agent_inbox_messages (
    message_id TEXT PRIMARY KEY,
    receiver_channel TEXT NOT NULL,
    receiver_thread_id TEXT,
    sender TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('human','parent','child','peer','contract','blocker')),
    body TEXT NOT NULL,
    ids JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS agent_inbox_messages_pending_idx
    ON agent_inbox_messages (receiver_channel, receiver_thread_id, created_at)
    WHERE delivered_at IS NULL;
`;

export const down = `DROP TABLE IF EXISTS agent_inbox_messages;`;

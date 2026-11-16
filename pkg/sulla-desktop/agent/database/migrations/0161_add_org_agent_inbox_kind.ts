// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export const up = `
  ALTER TABLE agent_inbox_messages ADD COLUMN IF NOT EXISTS host_seq BIGINT;
  ALTER TABLE agent_inbox_messages DROP CONSTRAINT IF EXISTS agent_inbox_messages_kind_check;
  ALTER TABLE agent_inbox_messages ADD CONSTRAINT agent_inbox_messages_kind_check
    CHECK (kind IN ('human','parent','child','peer','contract','blocker','org'));
`;

export const down = `
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM agent_inbox_messages WHERE kind='org') THEN
      RAISE EXCEPTION 'Cannot remove org inbox support while org messages are present';
    END IF;
  END $$;
  ALTER TABLE agent_inbox_messages DROP CONSTRAINT IF EXISTS agent_inbox_messages_kind_check;
  ALTER TABLE agent_inbox_messages ADD CONSTRAINT agent_inbox_messages_kind_check
    CHECK (kind IN ('human','parent','child','peer','contract','blocker'));
  ALTER TABLE agent_inbox_messages DROP COLUMN IF EXISTS host_seq;
`;

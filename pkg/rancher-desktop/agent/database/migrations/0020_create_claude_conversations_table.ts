// claude_conversations — local cache of Sulla chat conversations, mirrors
// the mobile SQLite schema (see sulla-mobile/src/db/migrations.ts v20) so the
// sync pipeline can apply inbound rows byte-for-byte.
export const up = `
  CREATE TABLE IF NOT EXISTS claude_conversations (
    id                    TEXT PRIMARY KEY,
    contractor_id         TEXT NOT NULL,
    title                 TEXT NOT NULL DEFAULT 'New Conversation',
    status                TEXT NOT NULL DEFAULT 'active',
    last_message_at       TIMESTAMP WITH TIME ZONE,
    last_message_preview  TEXT,
    unread_count          INTEGER NOT NULL DEFAULT 0,
    created_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at            TIMESTAMP WITH TIME ZONE
  );

  CREATE INDEX IF NOT EXISTS idx_claude_convos_contractor ON claude_conversations(contractor_id);
`;

export const down = `DROP TABLE IF EXISTS claude_conversations CASCADE;`;

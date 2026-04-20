// claude_messages — local cache of chat messages. Includes `routed_to` from
// day one (mobile added it in migration v21) so pulled rows carry the
// routing hint that decides who answers a given user turn.
export const up = `
  CREATE TABLE IF NOT EXISTS claude_messages (
    id              TEXT PRIMARY KEY,
    contractor_id   TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'user',
    content         TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'sent',
    routed_to       TEXT,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at      TIMESTAMP WITH TIME ZONE
  );

  CREATE INDEX IF NOT EXISTS idx_claude_msgs_convo      ON claude_messages(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_claude_msgs_contractor ON claude_messages(contractor_id);
  CREATE INDEX IF NOT EXISTS idx_claude_msgs_created    ON claude_messages(created_at);
`;

export const down = `DROP TABLE IF EXISTS claude_messages CASCADE;`;

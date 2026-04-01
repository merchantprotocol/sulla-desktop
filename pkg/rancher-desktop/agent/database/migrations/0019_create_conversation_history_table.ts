export const up = `
  CREATE TABLE IF NOT EXISTS conversation_history (
    id              TEXT PRIMARY KEY,
    thread_id       TEXT,
    session_id      TEXT,
    type            TEXT NOT NULL,
    title           TEXT,
    summary         TEXT,
    url             TEXT,
    favicon         TEXT,
    channel_id      TEXT,
    agent_id        TEXT,
    tab_id          TEXT,
    status          TEXT DEFAULT 'active',
    message_count   INTEGER DEFAULT 0,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_active_at  TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    closed_at       TIMESTAMP WITH TIME ZONE,
    log_file        TEXT,
    training_file   TEXT,
    last_summary    TEXT,
    pinned          BOOLEAN DEFAULT FALSE
  );

  CREATE INDEX IF NOT EXISTS idx_conv_history_thread_id      ON conversation_history(thread_id);
  CREATE INDEX IF NOT EXISTS idx_conv_history_session_id     ON conversation_history(session_id);
  CREATE INDEX IF NOT EXISTS idx_conv_history_status         ON conversation_history(status);
  CREATE INDEX IF NOT EXISTS idx_conv_history_type           ON conversation_history(type);
  CREATE INDEX IF NOT EXISTS idx_conv_history_last_active    ON conversation_history(last_active_at DESC);
  CREATE INDEX IF NOT EXISTS idx_conv_history_created_at     ON conversation_history(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_conv_history_channel_id     ON conversation_history(channel_id);
  CREATE INDEX IF NOT EXISTS idx_conv_history_agent_id       ON conversation_history(agent_id);
`;

export const down = `DROP TABLE IF EXISTS conversation_history CASCADE;`;

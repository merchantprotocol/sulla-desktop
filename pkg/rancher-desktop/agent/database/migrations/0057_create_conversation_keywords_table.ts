/**
 * Migration 0057 — Create conversation_keywords index table.
 *
 * Substrate for the Conversation-Recall subconscious agent (epic 01aZ): the
 * writer indexes salient terms per turn against thread/conversation id, and
 * the reader's DB-search tool (G7bd) queries this table instead of scanning
 * conversation_history (which stores only title/summary, not full content).
 *
 * Standalone table, not a conversation_history column — a conversation
 * produces many keywords over its lifetime, so this is a one-to-many child,
 * same shape as observations vs identity_observations.
 *
 * `source` distinguishes which loop wrote the term (primary chat vs a
 * subconscious/worker channel) since those already use separate channel_id
 * namespaces per the standing rule that domain loops stay separate.
 *
 * UNIQUE(term, thread_id) makes re-seeing a term in the same thread an
 * upsert (bump hit_count / last_seen) instead of a duplicate row.
 *
 * pg_trgm GIN index on term for fuzzy/substring match — consistent with the
 * no-embeddings constraint (pgvector isn't available on install; same
 * approach as migration 0041's observations.content trigram index).
 */

export const up = `
  CREATE EXTENSION IF NOT EXISTS pg_trgm;

  CREATE TABLE IF NOT EXISTS conversation_keywords (
    id                       TEXT        PRIMARY KEY,
    term                     TEXT        NOT NULL,
    thread_id                TEXT        NOT NULL,
    conversation_history_id  TEXT        REFERENCES conversation_history(id),
    channel_id               TEXT,
    agent_id                 TEXT,
    source                   TEXT        NOT NULL DEFAULT 'primary',
    first_seen               TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen                TIMESTAMPTZ NOT NULL DEFAULT now(),
    hit_count                INTEGER     NOT NULL DEFAULT 1,
    CONSTRAINT conversation_keywords_source_check
      CHECK (source IN ('primary', 'subconscious', 'worker'))
  );

  CREATE INDEX IF NOT EXISTS idx_conversation_keywords_thread
    ON conversation_keywords (thread_id);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_keywords_term_thread
    ON conversation_keywords (term, thread_id);

  CREATE INDEX IF NOT EXISTS idx_conversation_keywords_term_trgm
    ON conversation_keywords USING gin (term gin_trgm_ops);

  CREATE INDEX IF NOT EXISTS idx_conversation_keywords_conversation_history
    ON conversation_keywords (conversation_history_id)
    WHERE conversation_history_id IS NOT NULL;
`;

export const down = `DROP TABLE IF EXISTS conversation_keywords CASCADE;`;

// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Migration 0127 — Unified conversations store, stage 1 (additive).
 *
 * - Extends conversation_history (the conversation header) with the columns
 *   claude_conversations carried (contractor, unread, preview, soft delete).
 * - Creates conversation_messages: every message INCLUDING tool calls and tool
 *   results, keyed to conversation_history. Order within a conversation is seq.
 * - Backfills headers and messages from claude_conversations / claude_messages.
 *   Idempotent; claude_* tables are left untouched.
 */
export const up = `
  ALTER TABLE conversation_history ADD COLUMN IF NOT EXISTS contractor_id        TEXT;
  ALTER TABLE conversation_history ADD COLUMN IF NOT EXISTS source               TEXT;
  ALTER TABLE conversation_history ADD COLUMN IF NOT EXISTS unread_count         INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE conversation_history ADD COLUMN IF NOT EXISTS last_message_preview TEXT;
  ALTER TABLE conversation_history ADD COLUMN IF NOT EXISTS deleted_at           TIMESTAMPTZ;

  CREATE INDEX IF NOT EXISTS idx_conv_history_contractor
    ON conversation_history(contractor_id) WHERE contractor_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS conversation_messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversation_history(id) ON DELETE CASCADE,
    seq             BIGINT GENERATED ALWAYS AS IDENTITY,
    role            TEXT NOT NULL,
    content         TEXT,
    tool_calls      JSONB,
    tool_call_id    TEXT,
    tool_name       TEXT,
    tool_result     JSONB,
    parts           JSONB,
    model           TEXT,
    status          TEXT,
    routed_to       TEXT,
    source          TEXT,
    contractor_id   TEXT,
    meta            JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ
  );

  CREATE INDEX IF NOT EXISTS idx_conv_messages_conv_seq
    ON conversation_messages(conversation_id, seq);
  CREATE INDEX IF NOT EXISTS idx_conv_messages_conv_created
    ON conversation_messages(conversation_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_conv_messages_live
    ON conversation_messages(conversation_id, seq) WHERE deleted_at IS NULL;

  -- Backfill (i): headers for claude_conversations without a conversation_history row.
  -- The desktop/mobile origin is not recorded in claude_conversations, so source = 'desktop'.
  INSERT INTO conversation_history (
    id, type, title, status, message_count, created_at, last_active_at,
    pinned, hidden, contractor_id, source, unread_count, last_message_preview, deleted_at
  )
  SELECT
    cc.id, 'chat', cc.title,
    CASE WHEN cc.status = 'active' THEN 'active' ELSE 'closed' END,
    0, cc.created_at, COALESCE(cc.last_message_at, cc.updated_at, cc.created_at),
    FALSE, FALSE, cc.contractor_id, 'desktop', COALESCE(cc.unread_count, 0),
    cc.last_message_preview, cc.deleted_at
  FROM claude_conversations cc
  WHERE NOT EXISTS (SELECT 1 FROM conversation_history ch WHERE ch.id = cc.id);

  -- Backfill (i-b): existing headers only get their NULL/default columns filled.
  UPDATE conversation_history ch
  SET contractor_id        = COALESCE(ch.contractor_id, cc.contractor_id),
      last_message_preview = COALESCE(ch.last_message_preview, cc.last_message_preview),
      unread_count         = CASE WHEN ch.unread_count = 0 THEN COALESCE(cc.unread_count, 0) ELSE ch.unread_count END
  FROM claude_conversations cc
  WHERE cc.id = ch.id
    AND (ch.contractor_id IS NULL OR ch.last_message_preview IS NULL OR ch.unread_count = 0);

  -- Backfill (ii): messages (seq assigned in chronological order).
  INSERT INTO conversation_messages (
    id, conversation_id, role, content, status, routed_to, source,
    contractor_id, created_at, updated_at, deleted_at
  )
  SELECT
    cm.id, cm.conversation_id, cm.role, cm.content, cm.status, cm.routed_to, 'desktop',
    cm.contractor_id, cm.created_at, cm.updated_at, cm.deleted_at
  FROM claude_messages cm
  WHERE EXISTS (SELECT 1 FROM conversation_history ch WHERE ch.id = cm.conversation_id)
  ORDER BY cm.created_at, cm.id
  ON CONFLICT (id) DO NOTHING;

  -- Backfill (iii): refresh message_count for conversations that have messages.
  UPDATE conversation_history ch
  SET message_count = m.n
  FROM (
    SELECT conversation_id, COUNT(*)::int AS n
    FROM conversation_messages
    WHERE deleted_at IS NULL
    GROUP BY conversation_id
  ) m
  WHERE m.conversation_id = ch.id
    AND ch.message_count IS DISTINCT FROM m.n;
`;

export const down = `
  DROP TABLE IF EXISTS conversation_messages;
  DROP INDEX IF EXISTS idx_conv_history_contractor;
  ALTER TABLE conversation_history DROP COLUMN IF EXISTS contractor_id;
  ALTER TABLE conversation_history DROP COLUMN IF EXISTS source;
  ALTER TABLE conversation_history DROP COLUMN IF EXISTS unread_count;
  ALTER TABLE conversation_history DROP COLUMN IF EXISTS last_message_preview;
  ALTER TABLE conversation_history DROP COLUMN IF EXISTS deleted_at;
`;

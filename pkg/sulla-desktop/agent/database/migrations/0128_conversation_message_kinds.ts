// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Migration 0128 — Unified conversations store, stage 2 (additive).
 *
 * - conversation_messages gains first-class `kind` (the UI message kind),
 *   `turn_id`, `position` (order inside the saved thread) and `payload` (the
 *   original UI/graph message verbatim, so a thread restores exactly).
 * - conversation_history gains `thread_state`: the chat ThreadState with
 *   thread.messages emptied (run state, queue, artifacts, …).
 * - Backfills `kind` for stage-1 rows.
 * - One-time, idempotent import of the legacy chat_messages table when it
 *   exists (it was created lazily, so most installs never had it). The
 *   legacy table is left in place.
 *
 * The row mapping mirrors threadStateToRows() in models/ConversationThreadStore.ts.
 */
export const up = `
  ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS kind     TEXT;
  ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS turn_id  TEXT;
  ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS position INTEGER;
  ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS payload  JSONB;
  ALTER TABLE conversation_history  ADD COLUMN IF NOT EXISTS thread_state JSONB;

  CREATE INDEX IF NOT EXISTS idx_conv_messages_conv_position
    ON conversation_messages(conversation_id, position) WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_conv_messages_conv_kind
    ON conversation_messages(conversation_id, kind) WHERE deleted_at IS NULL;

  UPDATE conversation_messages
  SET kind = CASE role WHEN 'user' THEN 'user' WHEN 'assistant' THEN 'sulla' WHEN 'tool' THEN 'tool' ELSE 'system' END
  WHERE kind IS NULL;

  DO $$
  DECLARE
    r   record;
    hid text;
  BEGIN
    IF to_regclass('chat_messages') IS NULL THEN
      RETURN;
    END IF;

    FOR r IN EXECUTE 'SELECT id, thread_id, state_json, created_at, updated_at FROM chat_messages ORDER BY updated_at NULLS FIRST, id' LOOP
      CONTINUE WHEN r.state_json IS NULL OR jsonb_typeof(r.state_json) <> 'object';

      SELECT h.id INTO hid
      FROM conversation_history h
      WHERE h.id = r.id OR h.thread_id = r.id OR (r.thread_id IS NOT NULL AND h.thread_id = r.thread_id)
      ORDER BY (h.type = 'chat') DESC,
               (h.source IS DISTINCT FROM 'thread-placeholder') DESC,
               h.last_active_at DESC NULLS LAST
      LIMIT 1;

      IF hid IS NULL THEN
        INSERT INTO conversation_history (id, thread_id, type, title, status, hidden, source, message_count, created_at, last_active_at)
        VALUES (r.id, r.id, 'chat', r.state_json->'thread'->>'title', 'active', TRUE, 'thread-placeholder', 0,
                COALESCE(r.created_at, now()), COALESCE(r.updated_at, now()))
        ON CONFLICT (id) DO NOTHING;
        hid := r.id;
      END IF;

      IF jsonb_typeof(r.state_json->'thread'->'messages') = 'array' THEN
        INSERT INTO conversation_messages (
          id, conversation_id, role, content, tool_calls, tool_call_id, tool_name, tool_result,
          model, status, kind, turn_id, position, payload, created_at, updated_at
        )
        SELECT
          r.id || ':' || COALESCE(NULLIF(x.m->>'id', ''), 'i' || (x.ord - 1)),
          hid,
          CASE
            WHEN x.ui AND x.k = 'user' THEN 'user'
            WHEN x.ui AND x.k IN ('sulla', 'streaming', 'html', 'proactive', 'thinking') THEN 'assistant'
            WHEN x.ui AND x.k = 'tool' THEN 'tool'
            WHEN x.ui THEN 'system'
            WHEN x.m->>'role' IN ('user', 'assistant', 'tool', 'system') THEN x.m->>'role'
            ELSE 'system'
          END,
          CASE
            WHEN jsonb_typeof(x.m->'text') = 'string' THEN x.m->>'text'
            WHEN jsonb_typeof(x.m->'desc') = 'string' THEN x.m->>'desc'
            WHEN jsonb_typeof(x.m->'thoughts') = 'array' THEN
              (SELECT string_agg(t, chr(10)) FROM jsonb_array_elements_text(x.m->'thoughts') AS t)
            WHEN NOT x.ui AND jsonb_typeof(x.m->'content') = 'string' THEN x.m->>'content'
            WHEN NOT x.ui AND jsonb_typeof(x.m->'content') = 'array' THEN
              (SELECT string_agg(p->>'text', chr(10)) FROM jsonb_array_elements(x.m->'content') AS p
                WHERE jsonb_typeof(p) = 'object' AND jsonb_typeof(p->'text') = 'string')
            ELSE ''
          END,
          CASE
            WHEN x.ui AND x.k = 'tool' THEN jsonb_build_array(jsonb_build_object(
              'id', COALESCE(NULLIF(x.m->>'id', ''), 'i' || (x.ord - 1)), 'name', x.m->'tool', 'arguments', x.m->'input'))
            WHEN NOT x.ui AND jsonb_typeof(x.m->'tool_calls') = 'array' THEN x.m->'tool_calls'
          END,
          CASE
            WHEN x.ui AND x.k = 'tool' THEN COALESCE(NULLIF(x.m->>'id', ''), 'i' || (x.ord - 1))
            WHEN NOT x.ui AND jsonb_typeof(x.m->'tool_call_id') = 'string' THEN x.m->>'tool_call_id'
          END,
          CASE
            WHEN x.ui AND x.k = 'tool' AND jsonb_typeof(x.m->'tool') = 'string' THEN x.m->>'tool'
            WHEN NOT x.ui AND jsonb_typeof(x.m->'name') = 'string' THEN x.m->>'name'
          END,
          CASE WHEN x.ui AND x.k = 'tool' THEN jsonb_build_object(
            'status', x.m->'status', 'output', x.m->'output', 'error', x.m->'error', 'meta', x.m->'meta') END,
          CASE WHEN jsonb_typeof(x.m->'model') = 'string' THEN x.m->>'model' END,
          CASE WHEN jsonb_typeof(x.m->'status') = 'string' THEN x.m->>'status' END,
          x.k,
          CASE WHEN jsonb_typeof(x.m->'turnId') = 'string' THEN x.m->>'turnId' END,
          (x.ord - 1)::int,
          x.m,
          CASE WHEN jsonb_typeof(x.m->'createdAt') = 'number'
               THEN to_timestamp((x.m->>'createdAt')::double precision / 1000.0)
               ELSE COALESCE(r.updated_at, now()) END,
          now()
        FROM (
          SELECT e.m, e.ord,
                 COALESCE(jsonb_typeof(e.m->'kind') = 'string' AND e.m->>'kind' <> '', FALSE) AS ui,
                 CASE
                   WHEN jsonb_typeof(e.m->'kind') = 'string' AND e.m->>'kind' <> '' THEN e.m->>'kind'
                   WHEN e.m->>'role' = 'assistant' THEN 'sulla'
                   WHEN e.m->>'role' = 'tool' THEN 'tool'
                   ELSE COALESCE(NULLIF(e.m->>'role', ''), 'system')
                 END AS k
          FROM jsonb_array_elements(r.state_json->'thread'->'messages') WITH ORDINALITY AS e(m, ord)
          WHERE jsonb_typeof(e.m) = 'object'
        ) x
        ON CONFLICT (id) DO NOTHING;
      END IF;

      UPDATE conversation_history h
      SET thread_state = COALESCE(h.thread_state,
            CASE WHEN jsonb_typeof(r.state_json->'thread') = 'object'
                 THEN jsonb_set(r.state_json, '{thread,messages}', '[]'::jsonb, true)
                 ELSE r.state_json END),
          message_count = (SELECT COUNT(*)::int FROM conversation_messages WHERE conversation_id = hid AND deleted_at IS NULL),
          last_message_preview = COALESCE((
            SELECT LEFT(content, 200) FROM conversation_messages
            WHERE conversation_id = hid AND deleted_at IS NULL AND role IN ('user', 'assistant')
              AND content IS NOT NULL AND content <> ''
            ORDER BY position DESC NULLS LAST, seq DESC LIMIT 1), h.last_message_preview)
      WHERE h.id = hid;
    END LOOP;
  END
  $$;
`;

export const down = `
  DROP INDEX IF EXISTS idx_conv_messages_conv_position;
  DROP INDEX IF EXISTS idx_conv_messages_conv_kind;
  ALTER TABLE conversation_messages DROP COLUMN IF EXISTS kind;
  ALTER TABLE conversation_messages DROP COLUMN IF EXISTS turn_id;
  ALTER TABLE conversation_messages DROP COLUMN IF EXISTS position;
  ALTER TABLE conversation_messages DROP COLUMN IF EXISTS payload;
  ALTER TABLE conversation_history  DROP COLUMN IF EXISTS thread_state;
`;

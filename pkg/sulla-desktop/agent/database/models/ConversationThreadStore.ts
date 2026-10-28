// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// ConversationThreadStore.ts — chat/graph transcripts in the unified
// conversations store (stage 2).
//
// A conversation is one conversation_history row (the header) plus one
// conversation_messages row per transcript message — every kind, including
// tool calls and results. Each row keeps the original UI message verbatim in
// `payload`, ordered by `position`, so a thread restores exactly as saved.
// The non-message part of the thread state (run state, queue, artifacts, …)
// lives in conversation_history.thread_state with thread.messages emptied.
//
// All logic takes an injected Queryable so tests can run it against a real
// pg client; the exported ConversationThreadStore wraps it in a transaction.

import { postgresClient } from '../PostgresClient';

export interface Queryable {
  query(text: string, params?: any[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export interface ChatThreadState {
  thread: {
    id:            string;
    title?:        string;
    messages:      any[];
    [key: string]: any;
  };
  [key: string]: any;
}

export interface ConversationMessageRow {
  id:           string;
  position:     number;
  kind:         string;
  role:         string;
  content:      string;
  turn_id:      string | null;
  tool_name:    string | null;
  tool_call_id: string | null;
  tool_calls:   any[] | null;
  tool_result:  Record<string, any> | null;
  model:        string | null;
  status:       string | null;
  created_ms:   number | null;
  payload:      any;
}

const ASSISTANT_KINDS = new Set(['sulla', 'streaming', 'html', 'proactive', 'thinking']);

/** UI kind → conversation_messages.role. */
export function roleForKind(kind: string): string {
  if (kind === 'user') return 'user';
  if (ASSISTANT_KINDS.has(kind)) return 'assistant';
  if (kind === 'tool') return 'tool';
  return 'system';
}

/** Graph-format messages ({role, content, tool_calls, …}) have no `kind`. */
function kindForGraphRole(role: unknown): string {
  if (role === 'assistant') return 'sulla';
  if (role === 'tool') return 'tool';
  return typeof role === 'string' && role ? role : 'system';
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function graphContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => (typeof part === 'string' ? part : (typeof part?.text === 'string' ? part.text : '')))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** Plain text for search / preview: text, else desc, else joined thoughts. */
function contentText(m: any): string {
  if (typeof m?.text === 'string') return m.text;
  if (typeof m?.desc === 'string') return m.desc;
  if (Array.isArray(m?.thoughts)) return m.thoughts.filter((t: unknown) => typeof t === 'string').join('\n');
  if (!m?.kind) return graphContentText(m?.content);
  return '';
}

/**
 * Pure mapper: thread state → conversation_messages rows. Row ids are
 * `${threadId}:${message.id}` (graph messages without an id use `i${index}`);
 * a repeated id within one save gets a `~${index}` suffix so no message is
 * silently dropped by the single-statement upsert.
 */
export function threadStateToRows(threadId: string, state: ChatThreadState | null | undefined): ConversationMessageRow[] {
  const messages = Array.isArray(state?.thread?.messages) ? state.thread.messages : [];
  const seen = new Set<string>();
  const rows: ConversationMessageRow[] = [];

  messages.forEach((m: any, index: number) => {
    if (!m || typeof m !== 'object') return;
    const isUi = typeof m.kind === 'string' && m.kind !== '';
    const kind = isUi ? m.kind : kindForGraphRole(m.role);
    const suffix = (m.id !== undefined && m.id !== null && m.id !== '') ? String(m.id) : `i${ index }`;
    let id = `${ threadId }:${ suffix }`;
    if (seen.has(id)) id = `${ id }~${ index }`;
    seen.add(id);

    let toolName: string | null = null;
    let toolCallId: string | null = null;
    let toolCalls: any[] | null = null;
    let toolResult: Record<string, any> | null = null;

    if (isUi && kind === 'tool') {
      toolName = str(m.tool);
      toolCallId = suffix;
      toolCalls = [{ id: suffix, name: m.tool ?? null, arguments: m.input ?? null }];
      toolResult = { status: m.status ?? null, output: m.output ?? null, error: m.error ?? null, meta: m.meta ?? null };
    } else if (!isUi) {
      toolName = str(m.name);
      toolCallId = str(m.tool_call_id);
      toolCalls = Array.isArray(m.tool_calls) ? m.tool_calls : null;
    }

    rows.push({
      id,
      position:     index,
      kind,
      role:         isUi ? roleForKind(kind) : (['user', 'assistant', 'tool', 'system'].includes(m.role) ? m.role : 'system'),
      content:      contentText(m),
      turn_id:      str(m.turnId),
      tool_name:    toolName,
      tool_call_id: toolCallId,
      tool_calls:   toolCalls,
      tool_result:  toolResult,
      model:        str(m.model),
      status:       str(m.status),
      created_ms:   typeof m.createdAt === 'number' && Number.isFinite(m.createdAt) ? m.createdAt : null,
      payload:      m,
    });
  });

  return rows;
}

/** The state with thread.messages emptied — everything else kept. */
export function stripMessages(state: ChatThreadState): ChatThreadState {
  return { ...state, thread: { ...(state?.thread ?? {} as any), messages: [] } };
}

const RESOLVE_SQL = `
  SELECT id FROM conversation_history
  WHERE id = $1 OR thread_id = $1
  ORDER BY (type = 'chat') DESC,
           (source IS DISTINCT FROM 'thread-placeholder') DESC,
           last_active_at DESC NULLS LAST
  LIMIT 1
`;

/** Serialise writers of one thread id (save / adopt) inside a transaction. */
async function lockThread(db: Queryable, key: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext('conv-thread:' || $1))`, [key]);
}

export async function resolveHeaderId(db: Queryable, idOrThreadId: string): Promise<string | null> {
  const r = await db.query(RESOLVE_SQL, [idOrThreadId]);
  return r.rows[0]?.id ?? null;
}

async function resolveOrCreateHeader(db: Queryable, threadId: string, title: string | null): Promise<string> {
  const existing = await resolveHeaderId(db, threadId);
  if (existing) return existing;
  await db.query(`
    INSERT INTO conversation_history (id, thread_id, type, title, status, hidden, source, message_count, created_at, last_active_at)
    VALUES ($1, $1, 'chat', $2, 'active', TRUE, 'thread-placeholder', 0, now(), now())
    ON CONFLICT (id) DO NOTHING
  `, [threadId, title]);
  return (await resolveHeaderId(db, threadId)) ?? threadId;
}

/** Recompute message_count / preview / last_active_at for one header. */
async function refreshHeader(db: Queryable, headerId: string): Promise<void> {
  await db.query(`
    UPDATE conversation_history h
    SET message_count = s.n,
        last_message_preview = COALESCE(s.preview, h.last_message_preview),
        last_active_at = GREATEST(h.last_active_at, s.last_at)
    FROM (
      SELECT
        (SELECT COUNT(*)::int FROM conversation_messages WHERE conversation_id = $1 AND deleted_at IS NULL) AS n,
        (SELECT LEFT(content, 200) FROM conversation_messages
          WHERE conversation_id = $1 AND deleted_at IS NULL AND role IN ('user', 'assistant')
            AND content IS NOT NULL AND content <> ''
          ORDER BY position DESC NULLS LAST, seq DESC LIMIT 1) AS preview,
        (SELECT MAX(created_at) FROM conversation_messages WHERE conversation_id = $1 AND deleted_at IS NULL) AS last_at
    ) s
    WHERE h.id = $1
  `, [headerId]);
}

export async function saveThreadStateWith(db: Queryable, threadId: string, state: ChatThreadState): Promise<string> {
  if (!threadId) throw new Error('saveThreadState: threadId is required');
  await lockThread(db, threadId);
  const title = typeof state?.thread?.title === 'string' ? state.thread.title : null;
  const headerId = await resolveOrCreateHeader(db, threadId, title);
  // A tab row linked after the placeholder was written: fold the placeholder in.
  if (headerId !== threadId) await adoptThreadMessagesWith(db, headerId, threadId);
  const rows = threadStateToRows(threadId, state);

  if (rows.length > 0) {
    await db.query(`
      INSERT INTO conversation_messages (
        id, conversation_id, role, content, tool_calls, tool_call_id, tool_name, tool_result,
        model, status, kind, turn_id, position, payload, created_at, updated_at
      )
      SELECT r.id, $2, r.role, r.content, r.tool_calls, r.tool_call_id, r.tool_name, r.tool_result,
             r.model, r.status, r.kind, r.turn_id, r.position, r.payload,
             CASE WHEN r.created_ms IS NOT NULL THEN to_timestamp(r.created_ms / 1000.0) ELSE now() END,
             now()
      FROM jsonb_to_recordset($1::jsonb) AS r(
        id text, role text, content text, tool_calls jsonb, tool_call_id text, tool_name text,
        tool_result jsonb, model text, status text, kind text, turn_id text, position integer,
        payload jsonb, created_ms double precision
      )
      ON CONFLICT (id) DO UPDATE SET
        conversation_id = EXCLUDED.conversation_id,
        role            = EXCLUDED.role,
        content         = EXCLUDED.content,
        tool_calls      = EXCLUDED.tool_calls,
        tool_call_id    = EXCLUDED.tool_call_id,
        tool_name       = EXCLUDED.tool_name,
        tool_result     = EXCLUDED.tool_result,
        model           = EXCLUDED.model,
        status          = EXCLUDED.status,
        kind            = EXCLUDED.kind,
        turn_id         = EXCLUDED.turn_id,
        position        = EXCLUDED.position,
        payload         = EXCLUDED.payload,
        deleted_at      = NULL,
        updated_at      = now()
      WHERE conversation_messages.payload IS DISTINCT FROM EXCLUDED.payload
         OR conversation_messages.position IS DISTINCT FROM EXCLUDED.position
         OR conversation_messages.conversation_id IS DISTINCT FROM EXCLUDED.conversation_id
         OR conversation_messages.deleted_at IS NOT NULL
    `, [JSON.stringify(rows), headerId]);
  }

  await db.query(`
    UPDATE conversation_messages
    SET deleted_at = now(), updated_at = now()
    WHERE conversation_id = $1 AND payload IS NOT NULL AND deleted_at IS NULL
      AND NOT (id = ANY($2::text[]))
  `, [headerId, rows.map(r => r.id)]);

  // Title only fills a placeholder header; a real tab row's title/status/pinned/hidden are never touched.
  await db.query(`
    UPDATE conversation_history
    SET thread_state = $2::jsonb,
        title = CASE WHEN source = 'thread-placeholder' THEN COALESCE($3, title) ELSE title END
    WHERE id = $1
  `, [headerId, JSON.stringify(stripMessages(state)), title]);
  await refreshHeader(db, headerId);
  return headerId;
}

export async function loadThreadStateWith(db: Queryable, idOrThreadId: string): Promise<ChatThreadState | null> {
  if (!idOrThreadId) return null;
  const headerId = await resolveHeaderId(db, idOrThreadId);
  if (!headerId) return null;
  const r = await db.query(`
    SELECT h.id, h.thread_id, h.title, h.thread_state,
           COALESCE((
             SELECT jsonb_agg(m.payload ORDER BY m.position, m.seq)
             FROM conversation_messages m
             WHERE m.conversation_id = h.id AND m.deleted_at IS NULL AND m.payload IS NOT NULL
           ), '[]'::jsonb) AS messages
    FROM conversation_history h
    WHERE h.id = $1
  `, [headerId]);
  const row = r.rows[0];
  if (!row) return null;
  const messages: any[] = Array.isArray(row.messages) ? row.messages : [];
  const base = row.thread_state && typeof row.thread_state === 'object' ? row.thread_state : null;
  if (!base && messages.length === 0) return null;
  const state: ChatThreadState = base ?? { thread: { id: row.thread_id || row.id, title: row.title ?? '', messages: [] } };
  return { ...state, thread: { ...(state.thread ?? {} as any), messages } };
}

export async function deleteThreadStateWith(db: Queryable, idOrThreadId: string): Promise<void> {
  const headerId = await resolveHeaderId(db, idOrThreadId);
  if (!headerId) return;
  await db.query(`
    UPDATE conversation_messages SET deleted_at = now(), updated_at = now()
    WHERE conversation_id = $1 AND payload IS NOT NULL AND deleted_at IS NULL
  `, [headerId]);
  await db.query(`UPDATE conversation_history SET thread_state = NULL WHERE id = $1`, [headerId]);
  await refreshHeader(db, headerId);
}

export async function getMessageCountWith(db: Queryable, idOrThreadId: string): Promise<number> {
  const headerId = await resolveHeaderId(db, idOrThreadId);
  if (!headerId) return 0;
  const r = await db.query(`
    SELECT COUNT(*)::int AS n FROM conversation_messages WHERE conversation_id = $1 AND deleted_at IS NULL
  `, [headerId]);
  return r.rows[0]?.n ?? 0;
}

/**
 * Move a thread's transcript from its hidden placeholder header (id =
 * threadId) onto the real tab row once linkThreads has connected them.
 * Idempotent: no placeholder, no tab row, or tabId === threadId → no-op.
 */
export async function adoptThreadMessagesWith(db: Queryable, tabId: string, threadId: string): Promise<boolean> {
  if (!tabId || !threadId || tabId === threadId) return false;
  await lockThread(db, threadId);
  const r = await db.query(`
    SELECT
      (SELECT id FROM conversation_history WHERE id = $2 AND source = 'thread-placeholder' AND hidden = TRUE) AS placeholder,
      (SELECT id FROM conversation_history WHERE id = $1) AS tab
  `, [tabId, threadId]);
  const { placeholder, tab } = r.rows[0] ?? {};
  if (!placeholder || !tab) return false;

  await db.query(`UPDATE conversation_messages SET conversation_id = $1, updated_at = now() WHERE conversation_id = $2`, [tabId, threadId]);
  await db.query(`
    UPDATE conversation_history t
    SET thread_state = COALESCE(t.thread_state, p.thread_state)
    FROM conversation_history p
    WHERE t.id = $1 AND p.id = $2
  `, [tabId, threadId]);
  await db.query(`DELETE FROM conversation_history WHERE id = $1 AND source = 'thread-placeholder'`, [threadId]);
  await refreshHeader(db, tabId);
  return true;
}

export class ConversationThreadStore {
  static saveThreadState(threadId: string, state: ChatThreadState): Promise<string> {
    return postgresClient.transaction(client => saveThreadStateWith(client, threadId, state));
  }

  static loadThreadState(idOrThreadId: string): Promise<ChatThreadState | null> {
    return postgresClient.transaction(client => loadThreadStateWith(client, idOrThreadId));
  }

  static deleteThreadState(idOrThreadId: string): Promise<void> {
    return postgresClient.transaction(client => deleteThreadStateWith(client, idOrThreadId));
  }

  static getMessageCount(idOrThreadId: string): Promise<number> {
    return postgresClient.transaction(client => getMessageCountWith(client, idOrThreadId));
  }

  static adoptThreadMessages(tabId: string, threadId: string): Promise<boolean> {
    return postgresClient.transaction(client => adoptThreadMessagesWith(client, tabId, threadId));
  }
}

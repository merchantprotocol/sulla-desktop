// ConversationMessagesModel.ts
// Unified message store (table created by migration 0127). Every message,
// including tool calls and tool results, keyed to conversation_history.
// No ensureTable: the schema comes from the numbered migration only.

import type { PoolClient } from 'pg';

import { postgresClient } from '../PostgresClient';

export type ConversationMessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ConversationToolCall {
  id:        string;
  name:      string;
  arguments: unknown;
}

export interface ConversationMessageRecord {
  id:              string;
  conversation_id: string;
  seq:             string; // bigint comes back from pg as a string
  role:            ConversationMessageRole;
  content:         string | null;
  tool_calls:      ConversationToolCall[] | null;
  tool_call_id:    string | null;
  tool_name:       string | null;
  tool_result:     unknown;
  parts:           unknown;
  model:           string | null;
  status:          string | null;
  routed_to:       string | null;
  source:          string | null;
  contractor_id:   string | null;
  meta:            Record<string, unknown>;
  created_at:      string;
  updated_at:      string;
  deleted_at:      string | null;
}

export interface AppendConversationMessageInput {
  id:              string;
  conversation_id: string;
  role:            ConversationMessageRole;
  content?:        string | null;
  tool_calls?:     ConversationToolCall[] | null;
  tool_call_id?:   string | null;
  tool_name?:      string | null;
  tool_result?:    unknown;
  parts?:          unknown;
  model?:          string | null;
  status?:         string | null;
  routed_to?:      string | null;
  source?:         string | null;
  contractor_id?:  string | null;
  meta?:           Record<string, unknown>;
  created_at?:     string;
}

export interface ListConversationMessagesOptions {
  limit?:          number;
  beforeSeq?:      string | number;
  includeDeleted?: boolean;
}

const COLUMNS = `id, conversation_id, seq::text AS seq, role, content, tool_calls, tool_call_id, tool_name,
  tool_result, parts, model, status, routed_to, source, contractor_id, meta,
  created_at, updated_at, deleted_at`;

function json(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

async function insertOne(client: Pick<PoolClient, 'query'>, m: AppendConversationMessageInput): Promise<void> {
  await client.query(
    `INSERT INTO conversation_messages (
       id, conversation_id, role, content, tool_calls, tool_call_id, tool_name, tool_result,
       parts, model, status, routed_to, source, contractor_id, meta, created_at
     ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15::jsonb,COALESCE($16::timestamptz, now()))
     ON CONFLICT (id) DO UPDATE SET
       content      = EXCLUDED.content,
       tool_calls   = EXCLUDED.tool_calls,
       tool_call_id = EXCLUDED.tool_call_id,
       tool_name    = EXCLUDED.tool_name,
       tool_result  = EXCLUDED.tool_result,
       parts        = EXCLUDED.parts,
       model        = EXCLUDED.model,
       status       = EXCLUDED.status,
       routed_to    = EXCLUDED.routed_to,
       meta         = EXCLUDED.meta,
       updated_at   = now(),
       deleted_at   = NULL`,
    [
      m.id, m.conversation_id, m.role, m.content ?? null, json(m.tool_calls), m.tool_call_id ?? null,
      m.tool_name ?? null, json(m.tool_result), json(m.parts), m.model ?? null, m.status ?? null,
      m.routed_to ?? null, m.source ?? null, m.contractor_id ?? null, JSON.stringify(m.meta ?? {}),
      m.created_at ?? null,
    ],
  );
}

/** Recompute header counters/preview for the touched conversations. */
async function refreshHeaders(client: Pick<PoolClient, 'query'>, conversationIds: string[]): Promise<void> {
  await client.query(
    `UPDATE conversation_history ch
     SET message_count = s.n,
         last_active_at = now(),
         last_message_preview = COALESCE(left(s.last_content, 200), ch.last_message_preview)
     FROM (
       SELECT c.id AS conversation_id,
              (SELECT COUNT(*)::int FROM conversation_messages m WHERE m.conversation_id = c.id AND m.deleted_at IS NULL) AS n,
              (SELECT m.content FROM conversation_messages m
                WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
                  AND m.role IN ('user','assistant') AND m.content IS NOT NULL AND m.content <> ''
                ORDER BY m.seq DESC LIMIT 1) AS last_content
       FROM conversation_history c
       WHERE c.id = ANY($1::text[])
     ) s
     WHERE ch.id = s.conversation_id`,
    [conversationIds],
  );
}

export class ConversationMessagesModel {
  /** Idempotent single insert; bumps the conversation header in the same transaction. */
  static async append(msg: AppendConversationMessageInput): Promise<void> {
    await ConversationMessagesModel.appendMany([msg]);
  }

  static async appendMany(msgs: AppendConversationMessageInput[]): Promise<void> {
    if (!msgs.length) {
      return;
    }
    await postgresClient.transaction(async(client) => {
      for (const m of msgs) {
        await insertOne(client, m);
      }
      await refreshHeaders(client, Array.from(new Set(msgs.map(m => m.conversation_id))));
    });
  }

  /** Ascending-by-seq window. With `limit`, returns the newest `limit` rows older than `beforeSeq`. */
  static async list(conversationId: string, opts: ListConversationMessagesOptions = {}): Promise<ConversationMessageRecord[]> {
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? 200), 1), 2000);
    const params: any[] = [conversationId, limit];
    let where = 'conversation_id = $1';
    if (!opts.includeDeleted) {
      where += ' AND deleted_at IS NULL';
    }
    if (opts.beforeSeq !== undefined && opts.beforeSeq !== null) {
      params.push(String(opts.beforeSeq));
      where += ` AND seq < $${ params.length }::bigint`;
    }
    return postgresClient.queryAll<ConversationMessageRecord>(
      `SELECT * FROM (
         SELECT ${ COLUMNS } FROM conversation_messages WHERE ${ where } ORDER BY seq DESC LIMIT $2
       ) t ORDER BY t.seq ASC`,
      params,
    );
  }

  static async count(conversationId: string): Promise<number> {
    const row = await postgresClient.queryOne<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM conversation_messages WHERE conversation_id = $1 AND deleted_at IS NULL',
      [conversationId],
    );
    return row?.n ?? 0;
  }

  /** Soft-delete every message in a conversation. */
  static async softDelete(conversationId: string): Promise<void> {
    await postgresClient.transaction(async(client) => {
      await client.query(
        'UPDATE conversation_messages SET deleted_at = now(), updated_at = now() WHERE conversation_id = $1 AND deleted_at IS NULL',
        [conversationId],
      );
      await client.query('UPDATE conversation_history SET message_count = 0 WHERE id = $1', [conversationId]);
    });
  }
}

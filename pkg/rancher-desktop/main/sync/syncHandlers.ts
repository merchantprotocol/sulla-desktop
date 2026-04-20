/**
 * Sync handlers registry — one per dataType we exchange with sulla-workers.
 *
 * Mirrors sulla-mobile/src/services/sync-handlers.ts in structure so both
 * ends of the pipeline apply the same upsert/soft-delete semantics with
 * last-write-wins conflict resolution via `updated_at`.
 *
 * Handlers exposed today:
 *   - claude_conversation
 *   - claude_message
 *
 * When a pulled claude_message is a user turn tagged `routed_to='desktop'`
 * and has no assistant reply yet, the handler kicks off dispatchClaude()
 * (fire-and-forget) so desktop can handle messages that arrived while the
 * WebSocket relay was offline.
 */

import { postgresClient } from '@pkg/agent/database/PostgresClient';
import { dispatchClaudeForMessage } from './syncDispatcher';

export interface SyncItem {
  dataType:  string;
  entityId:  string;
  payload:   string; // JSON string
  updatedAt: string;
  deleted:   boolean;
}

export interface SyncHandler {
  readLocal(recordKey: Record<string, unknown>): Promise<SyncItem | null>;
  applyRemote(item: SyncItem, contractorId: string): Promise<void>;
}

// ── claude_conversation ─────────────────────────────────────

const claudeConversationHandler: SyncHandler = {
  async readLocal(key) {
    const id = key.id as string;
    if (!id) return null;
    const rows = await postgresClient.query<any>(
      'SELECT * FROM claude_conversations WHERE id = $1',
      [id],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      dataType:  'claude_conversation',
      entityId:  row.id,
      payload:   JSON.stringify(row),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
      deleted:   !!row.deleted_at,
    };
  },

  async applyRemote(item, _contractorId) {
    let data: any;
    try { data = JSON.parse(item.payload) } catch { return }
    if (!data?.id) return;

    if (item.deleted || data.deleted_at) {
      await postgresClient.query(
        `UPDATE claude_conversations
         SET deleted_at = COALESCE($1, CURRENT_TIMESTAMP),
             updated_at = $2
         WHERE id = $3 AND (updated_at IS NULL OR updated_at < $2)`,
        [data.deleted_at ?? null, item.updatedAt, data.id],
      );
      return;
    }

    await postgresClient.query(
      `INSERT INTO claude_conversations
         (id, contractor_id, title, status, last_message_at, last_message_preview,
          unread_count, created_at, updated_at, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET
         title                = EXCLUDED.title,
         status               = EXCLUDED.status,
         last_message_at      = EXCLUDED.last_message_at,
         last_message_preview = EXCLUDED.last_message_preview,
         unread_count         = EXCLUDED.unread_count,
         updated_at           = EXCLUDED.updated_at,
         deleted_at           = EXCLUDED.deleted_at
       WHERE EXCLUDED.updated_at > claude_conversations.updated_at`,
      [
        data.id,
        data.contractor_id ?? null,
        data.title ?? 'New Conversation',
        data.status ?? 'active',
        data.last_message_at ?? null,
        data.last_message_preview ?? null,
        data.unread_count ?? 0,
        data.created_at ?? item.updatedAt,
        data.updated_at ?? item.updatedAt,
        data.deleted_at ?? null,
      ],
    );
  },
};

// ── claude_message ──────────────────────────────────────────

const claudeMessageHandler: SyncHandler = {
  async readLocal(key) {
    const id = key.id as string;
    if (!id) return null;
    const rows = await postgresClient.query<any>(
      'SELECT * FROM claude_messages WHERE id = $1',
      [id],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      dataType:  'claude_message',
      entityId:  row.id,
      payload:   JSON.stringify(row),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
      deleted:   !!row.deleted_at,
    };
  },

  async applyRemote(item, contractorId) {
    let data: any;
    try { data = JSON.parse(item.payload) } catch { return }
    if (!data?.id) return;

    if (item.deleted || data.deleted_at) {
      await postgresClient.query(
        `UPDATE claude_messages
         SET deleted_at = COALESCE($1, CURRENT_TIMESTAMP),
             updated_at = $2
         WHERE id = $3 AND (updated_at IS NULL OR updated_at < $2)`,
        [data.deleted_at ?? null, item.updatedAt, data.id],
      );
      return;
    }

    await postgresClient.query(
      `INSERT INTO claude_messages
         (id, contractor_id, conversation_id, role, content, status,
          routed_to, created_at, updated_at, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET
         role       = EXCLUDED.role,
         content    = EXCLUDED.content,
         status     = EXCLUDED.status,
         routed_to  = COALESCE(EXCLUDED.routed_to, claude_messages.routed_to),
         updated_at = EXCLUDED.updated_at,
         deleted_at = EXCLUDED.deleted_at
       WHERE EXCLUDED.updated_at > claude_messages.updated_at`,
      [
        data.id,
        data.contractor_id ?? contractorId,
        data.conversation_id,
        data.role ?? 'user',
        data.content ?? '',
        data.status ?? 'sent',
        data.routed_to ?? null,
        data.created_at ?? item.updatedAt,
        data.updated_at ?? item.updatedAt,
        data.deleted_at ?? null,
      ],
    );

    // Dispatch to Claude when this is a user turn routed to desktop and
    // no assistant reply has landed yet. Fire-and-forget — the pull cursor
    // advances regardless of Claude completion time.
    if (
      (data.role ?? 'user') === 'user' &&
      data.routed_to === 'desktop' &&
      !data.deleted_at
    ) {
      dispatchClaudeForMessage({
        id:              data.id,
        contractor_id:   data.contractor_id ?? contractorId,
        conversation_id: data.conversation_id,
        created_at:      data.created_at ?? item.updatedAt,
      }).catch((err) => {
        console.warn('[SyncHandlers] dispatchClaudeForMessage failed:', err);
      });
    }
  },
};

// ── Registry ────────────────────────────────────────────────

export const syncHandlers: Record<string, SyncHandler> = {
  claude_conversation: claudeConversationHandler,
  claude_message:      claudeMessageHandler,
};

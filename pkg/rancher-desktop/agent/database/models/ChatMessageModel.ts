// ChatMessageModel.ts — Persistent storage for chat thread messages in PostgreSQL.
// Provides durability when localStorage is evicted due to size limits.

import { postgresClient } from '../PostgresClient';

export interface ChatThreadState {
  thread: {
    id: string;
    title: string;
    messages: any[];
    model?: string;
    [key: string]: any;
  };
  [key: string]: any;
}

export class ChatMessageModel {
  private static readonly TABLE = 'chat_messages';

  static async ensureTable(): Promise<void> {
    try {
      await postgresClient.query(`
        CREATE TABLE IF NOT EXISTS ${ ChatMessageModel.TABLE } (
          id                TEXT PRIMARY KEY,
          thread_id         TEXT NOT NULL,
          state_json        JSONB NOT NULL,
          message_count     INTEGER DEFAULT 0,
          created_at        TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at        TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Create indexes
      await postgresClient.query(`
        CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_id
        ON ${ ChatMessageModel.TABLE }(thread_id)
      `);
      await postgresClient.query(`
        CREATE INDEX IF NOT EXISTS idx_chat_messages_updated_at
        ON ${ ChatMessageModel.TABLE }(updated_at DESC)
      `);
    } catch (err) {
      console.error('[ChatMessageModel] Failed to ensure table:', err);
    }
  }

  /**
   * Save or update a thread's full state (including all messages).
   * This is called whenever the thread changes in localStorage.
   */
  static async saveThreadState(id: string, state: ChatThreadState): Promise<void> {
    try {
      const messageCount = state.thread?.messages?.length ?? 0;

      await postgresClient.query(`
        INSERT INTO ${ ChatMessageModel.TABLE }
          (id, thread_id, state_json, message_count, created_at, updated_at)
        VALUES ($1, $2, $3, $4, NOW(), NOW())
        ON CONFLICT (id) DO UPDATE SET
          state_json   = EXCLUDED.state_json,
          message_count = EXCLUDED.message_count,
          updated_at   = NOW()
      `, [
        id,
        state.thread?.id ?? id,
        JSON.stringify(state),
        messageCount,
      ]);
    } catch (err) {
      console.error('[ChatMessageModel] Failed to save thread state:', err);
    }
  }

  /**
   * Load a thread's full state from the database.
   * Returns null if not found.
   */
  static async loadThreadState(id: string): Promise<ChatThreadState | null> {
    try {
      const row = await postgresClient.queryOne<{ state_json: any }>(`
        SELECT state_json FROM ${ ChatMessageModel.TABLE }
        WHERE id = $1
      `, [id]);

      if (!row) return null;

      // state_json might be stored as string or already parsed depending on driver
      const parsed = typeof row.state_json === 'string'
        ? JSON.parse(row.state_json)
        : row.state_json;

      return parsed as ChatThreadState;
    } catch (err) {
      console.error('[ChatMessageModel] Failed to load thread state:', err);
      return null;
    }
  }

  /**
   * Load all threads for a given thread_id (usually just one, but allows for recovery scenarios).
   */
  static async loadThreadsByThreadId(threadId: string): Promise<ChatThreadState[]> {
    try {
      const rows = await postgresClient.query<{ state_json: any }>(`
        SELECT state_json FROM ${ ChatMessageModel.TABLE }
        WHERE thread_id = $1
        ORDER BY updated_at DESC
      `, [threadId]);

      return rows.map(row => {
        const parsed = typeof row.state_json === 'string'
          ? JSON.parse(row.state_json)
          : row.state_json;
        return parsed as ChatThreadState;
      });
    } catch (err) {
      console.error('[ChatMessageModel] Failed to load threads by thread_id:', err);
      return [];
    }
  }

  /**
   * Delete a thread's messages from the database.
   */
  static async deleteThreadState(id: string): Promise<void> {
    try {
      await postgresClient.query(`
        DELETE FROM ${ ChatMessageModel.TABLE }
        WHERE id = $1
      `, [id]);
    } catch (err) {
      console.error('[ChatMessageModel] Failed to delete thread state:', err);
    }
  }

  /**
   * Get message count for a thread without loading the full state.
   */
  static async getMessageCount(id: string): Promise<number> {
    try {
      const row = await postgresClient.queryOne<{ message_count: number }>(`
        SELECT message_count FROM ${ ChatMessageModel.TABLE }
        WHERE id = $1
      `, [id]);

      return row?.message_count ?? 0;
    } catch (err) {
      console.error('[ChatMessageModel] Failed to get message count:', err);
      return 0;
    }
  }

  /**
   * Clear very old thread states to prevent database bloat.
   * Keeps threads updated in the last 90 days.
   */
  static async clearOldThreadStates(daysOld: number = 90): Promise<number> {
    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - daysOld);

      const result = await postgresClient.query(`
        DELETE FROM ${ ChatMessageModel.TABLE }
        WHERE updated_at < $1
      `, [cutoff.toISOString()]);

      const deleted = result.rowCount ?? 0;
      console.log(`[ChatMessageModel] Cleared ${ deleted } old thread states (older than ${ daysOld } days)`);
      return deleted;
    } catch (err) {
      console.error('[ChatMessageModel] Failed to clear old states:', err);
      return 0;
    }
  }
}

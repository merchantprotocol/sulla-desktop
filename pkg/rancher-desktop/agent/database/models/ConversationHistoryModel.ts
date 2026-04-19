// ConversationHistoryModel.ts
// Centralized conversation history persistence in PostgreSQL.
// Replaces fragmented storage across localStorage, Redis TTL, and disk logs.

import { postgresClient } from '../PostgresClient';

export type ConversationHistoryType = 'chat' | 'browser' | 'workflow' | 'graph';
export type ConversationHistoryStatus = 'active' | 'closed' | 'archived' | 'deleted';

export interface ConversationHistoryRecord {
  id:             string;
  thread_id?:     string;
  session_id?:    string;
  type:           ConversationHistoryType;
  title?:         string;
  summary?:       string;
  url?:           string;
  favicon?:       string;
  channel_id?:    string;
  agent_id?:      string;
  tab_id?:        string;
  status:         ConversationHistoryStatus;
  message_count:  number;
  created_at:     string;
  last_active_at: string;
  closed_at?:     string;
  log_file?:      string;
  training_file?: string;
  last_summary?:  string;
  pinned:         boolean;
}

export interface RecordConversationInput {
  id:             string;
  type:           ConversationHistoryType;
  thread_id?:     string;
  session_id?:    string;
  title?:         string;
  summary?:       string;
  url?:           string;
  favicon?:       string;
  channel_id?:    string;
  agent_id?:      string;
  tab_id?:        string;
  status?:        ConversationHistoryStatus;
  log_file?:      string;
  training_file?: string;
  last_summary?:  string;
  pinned?:        boolean;
}

export class ConversationHistoryModel {
  private static readonly TABLE = 'conversation_history';

  // ──────────────────────────────────────────────
  // Table setup
  // ──────────────────────────────────────────────

  static async ensureTable(): Promise<void> {
    try {
      await postgresClient.query(`
        CREATE TABLE IF NOT EXISTS ${ ConversationHistoryModel.TABLE } (
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
          training_file   TEXT,  -- reference only; NEVER auto-delete (used for local model training)
          last_summary    TEXT,
          pinned          BOOLEAN DEFAULT FALSE
        )
      `);

      // Create indexes
      await postgresClient.query(`CREATE INDEX IF NOT EXISTS idx_conv_history_thread_id   ON ${ ConversationHistoryModel.TABLE }(thread_id)`);
      await postgresClient.query(`CREATE INDEX IF NOT EXISTS idx_conv_history_session_id  ON ${ ConversationHistoryModel.TABLE }(session_id)`);
      await postgresClient.query(`CREATE INDEX IF NOT EXISTS idx_conv_history_status      ON ${ ConversationHistoryModel.TABLE }(status)`);
      await postgresClient.query(`CREATE INDEX IF NOT EXISTS idx_conv_history_type        ON ${ ConversationHistoryModel.TABLE }(type)`);
      await postgresClient.query(`CREATE INDEX IF NOT EXISTS idx_conv_history_last_active ON ${ ConversationHistoryModel.TABLE }(last_active_at DESC)`);
      await postgresClient.query(`CREATE INDEX IF NOT EXISTS idx_conv_history_created_at  ON ${ ConversationHistoryModel.TABLE }(created_at DESC)`);
      await postgresClient.query(`CREATE INDEX IF NOT EXISTS idx_conv_history_channel_id  ON ${ ConversationHistoryModel.TABLE }(channel_id)`);
      await postgresClient.query(`CREATE INDEX IF NOT EXISTS idx_conv_history_agent_id    ON ${ ConversationHistoryModel.TABLE }(agent_id)`);
    } catch (err) {
      console.error('[ConversationHistoryModel] Failed to ensure table:', err);
    }
  }

  // ──────────────────────────────────────────────
  // Core CRUD
  // ──────────────────────────────────────────────

  /**
   * Insert or upsert a conversation record.
   */
  static async recordConversation(meta: RecordConversationInput): Promise<void> {
    try {
      await postgresClient.query(`
        INSERT INTO ${ ConversationHistoryModel.TABLE }
          (id, thread_id, session_id, type, title, summary, url, favicon,
           channel_id, agent_id, tab_id, status, log_file, training_file,
           last_summary, pinned, created_at, last_active_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW(), NOW())
        ON CONFLICT (id) DO UPDATE SET
          thread_id      = COALESCE(EXCLUDED.thread_id, ${ ConversationHistoryModel.TABLE }.thread_id),
          session_id     = COALESCE(EXCLUDED.session_id, ${ ConversationHistoryModel.TABLE }.session_id),
          type           = EXCLUDED.type,
          title          = COALESCE(EXCLUDED.title, ${ ConversationHistoryModel.TABLE }.title),
          summary        = COALESCE(EXCLUDED.summary, ${ ConversationHistoryModel.TABLE }.summary),
          url            = COALESCE(EXCLUDED.url, ${ ConversationHistoryModel.TABLE }.url),
          favicon        = COALESCE(EXCLUDED.favicon, ${ ConversationHistoryModel.TABLE }.favicon),
          channel_id     = COALESCE(EXCLUDED.channel_id, ${ ConversationHistoryModel.TABLE }.channel_id),
          agent_id       = COALESCE(EXCLUDED.agent_id, ${ ConversationHistoryModel.TABLE }.agent_id),
          tab_id         = COALESCE(EXCLUDED.tab_id, ${ ConversationHistoryModel.TABLE }.tab_id),
          status         = COALESCE(EXCLUDED.status, ${ ConversationHistoryModel.TABLE }.status),
          log_file       = COALESCE(EXCLUDED.log_file, ${ ConversationHistoryModel.TABLE }.log_file),
          training_file  = COALESCE(EXCLUDED.training_file, ${ ConversationHistoryModel.TABLE }.training_file),
          last_summary   = COALESCE(EXCLUDED.last_summary, ${ ConversationHistoryModel.TABLE }.last_summary),
          pinned         = COALESCE(EXCLUDED.pinned, ${ ConversationHistoryModel.TABLE }.pinned),
          last_active_at = NOW()
      `, [
        meta.id,
        meta.thread_id ?? null,
        meta.session_id ?? null,
        meta.type,
        meta.title ?? null,
        meta.summary ?? null,
        meta.url ?? null,
        meta.favicon ?? null,
        meta.channel_id ?? null,
        meta.agent_id ?? null,
        meta.tab_id ?? null,
        meta.status ?? 'active',
        meta.log_file ?? null,
        meta.training_file ?? null,
        meta.last_summary ?? null,
        meta.pinned ?? false,
      ]);
    } catch (err) {
      console.error('[ConversationHistoryModel] Failed to record conversation:', err);
    }
  }

  /**
   * Bump last_active_at and optionally update message_count.
   */
  static async updateActivity(id: string, messageCount?: number): Promise<void> {
    try {
      if (messageCount !== undefined) {
        await postgresClient.query(`
          UPDATE ${ ConversationHistoryModel.TABLE }
          SET last_active_at = NOW(), message_count = $2
          WHERE id = $1
        `, [id, messageCount]);
      } else {
        await postgresClient.query(`
          UPDATE ${ ConversationHistoryModel.TABLE }
          SET last_active_at = NOW(), message_count = message_count + 1
          WHERE id = $1
        `, [id]);
      }
    } catch (err) {
      console.error('[ConversationHistoryModel] Failed to update activity:', err);
    }
  }

  /**
   * Close a conversation (set status='closed', closed_at=now).
   */
  static async closeConversation(id: string): Promise<void> {
    try {
      await postgresClient.query(`
        UPDATE ${ ConversationHistoryModel.TABLE }
        SET status = 'closed', closed_at = NOW(), last_active_at = NOW()
        WHERE id = $1
      `, [id]);
    } catch (err) {
      console.error('[ConversationHistoryModel] Failed to close conversation:', err);
    }
  }

  /**
   * Update the title of a conversation.
   */
  static async updateTitle(id: string, title: string): Promise<void> {
    try {
      await postgresClient.query(`
        UPDATE ${ ConversationHistoryModel.TABLE }
        SET title = $2, last_active_at = NOW()
        WHERE id = $1
      `, [id, title]);
    } catch (err) {
      console.error('[ConversationHistoryModel] Failed to update title:', err);
    }
  }

  /**
   * Update summary and optionally last_summary (cached observations JSON).
   */
  static async updateSummary(id: string, summary: string, lastSummary?: string): Promise<void> {
    try {
      if (lastSummary !== undefined) {
        await postgresClient.query(`
          UPDATE ${ ConversationHistoryModel.TABLE }
          SET summary = $2, last_summary = $3, last_active_at = NOW()
          WHERE id = $1
        `, [id, summary, lastSummary]);
      } else {
        await postgresClient.query(`
          UPDATE ${ ConversationHistoryModel.TABLE }
          SET summary = $2, last_active_at = NOW()
          WHERE id = $1
        `, [id, summary]);
      }
    } catch (err) {
      console.error('[ConversationHistoryModel] Failed to update summary:', err);
    }
  }

  // ──────────────────────────────────────────────
  // Queries
  // ──────────────────────────────────────────────

  /**
   * Get recent conversations ordered by last_active_at, optionally filtered by type.
   */
  static async getRecent(limit = 50, type?: ConversationHistoryType): Promise<ConversationHistoryRecord[]> {
    try {
      if (type) {
        return await postgresClient.query<ConversationHistoryRecord>(`
          SELECT * FROM ${ ConversationHistoryModel.TABLE }
          WHERE type = $1 AND status != 'deleted'
          ORDER BY last_active_at DESC
          LIMIT $2
        `, [type, limit]);
      }
      return await postgresClient.query<ConversationHistoryRecord>(`
        SELECT * FROM ${ ConversationHistoryModel.TABLE }
        WHERE status != 'deleted'
        ORDER BY last_active_at DESC
        LIMIT $1
      `, [limit]);
    } catch (err) {
      console.error('[ConversationHistoryModel] Failed to get recent:', err);
      return [];
    }
  }

  /**
   * Search conversations by title and summary using ILIKE.
   */
  static async search(query: string): Promise<ConversationHistoryRecord[]> {
    try {
      const pattern = `%${ query }%`;
      return await postgresClient.query<ConversationHistoryRecord>(`
        SELECT * FROM ${ ConversationHistoryModel.TABLE }
        WHERE (title ILIKE $1 OR summary ILIKE $1) AND status != 'deleted'
        ORDER BY last_active_at DESC
        LIMIT 100
      `, [pattern]);
    } catch (err) {
      console.error('[ConversationHistoryModel] Failed to search:', err);
      return [];
    }
  }

  /**
   * Get conversations within a date range.
   */
  static async getByDateRange(from: Date, to: Date): Promise<ConversationHistoryRecord[]> {
    try {
      return await postgresClient.query<ConversationHistoryRecord>(`
        SELECT * FROM ${ ConversationHistoryModel.TABLE }
        WHERE created_at >= $1 AND created_at <= $2 AND status != 'deleted'
        ORDER BY last_active_at DESC
      `, [from.toISOString(), to.toISOString()]);
    } catch (err) {
      console.error('[ConversationHistoryModel] Failed to get by date range:', err);
      return [];
    }
  }

  /**
   * Lookup by thread_id.
   */
  static async getByThread(threadId: string): Promise<ConversationHistoryRecord | null> {
    try {
      return await postgresClient.queryOne<ConversationHistoryRecord>(`
        SELECT * FROM ${ ConversationHistoryModel.TABLE }
        WHERE thread_id = $1
        ORDER BY last_active_at DESC
        LIMIT 1
      `, [threadId]);
    } catch (err) {
      console.error('[ConversationHistoryModel] Failed to get by thread:', err);
      return null;
    }
  }

  /**
   * Lookup by id.
   */
  static async getById(id: string): Promise<ConversationHistoryRecord | null> {
    try {
      return await postgresClient.queryOne<ConversationHistoryRecord>(`
        SELECT * FROM ${ ConversationHistoryModel.TABLE }
        WHERE id = $1
      `, [id]);
    } catch (err) {
      console.error('[ConversationHistoryModel] Failed to get by id:', err);
      return null;
    }
  }

  // ──────────────────────────────────────────────
  // Deletion & archival
  // ──────────────────────────────────────────────

  /**
   * Hard delete a conversation record.
   */
  static async deleteConversation(id: string): Promise<void> {
    try {
      await postgresClient.query(`
        DELETE FROM ${ ConversationHistoryModel.TABLE }
        WHERE id = $1
      `, [id]);
    } catch (err) {
      console.error('[ConversationHistoryModel] Failed to delete conversation:', err);
    }
  }

  /**
   * Bulk delete with optional date filter. Returns deleted entries so caller can clean up files.
   */
  static async clearHistory(olderThan?: Date): Promise<ConversationHistoryRecord[]> {
    try {
      if (olderThan) {
        const deleted = await postgresClient.query<ConversationHistoryRecord>(`
          DELETE FROM ${ ConversationHistoryModel.TABLE }
          WHERE created_at < $1
          RETURNING *
        `, [olderThan.toISOString()]);
        return deleted;
      }
      const deleted = await postgresClient.query<ConversationHistoryRecord>(`
        DELETE FROM ${ ConversationHistoryModel.TABLE }
        RETURNING *
      `);
      return deleted;
    } catch (err) {
      console.error('[ConversationHistoryModel] Failed to clear history:', err);
      return [];
    }
  }

  /**
   * Set status='archived'.
   */
  static async archiveConversation(id: string): Promise<void> {
    try {
      await postgresClient.query(`
        UPDATE ${ ConversationHistoryModel.TABLE }
        SET status = 'archived', last_active_at = NOW()
        WHERE id = $1
      `, [id]);
    } catch (err) {
      console.error('[ConversationHistoryModel] Failed to archive conversation:', err);
    }
  }

  /**
   * Toggle pinned state.
   */
  static async pin(id: string, pinned: boolean): Promise<void> {
    try {
      await postgresClient.query(`
        UPDATE ${ ConversationHistoryModel.TABLE }
        SET pinned = $2
        WHERE id = $1
      `, [id, pinned]);
    } catch (err) {
      console.error('[ConversationHistoryModel] Failed to update pin:', err);
    }
  }

  /**
   * Return log_file and training_file paths for cleanup.
   */
  static async getFileAssociations(id: string): Promise<{ log_file: string | null; training_file: string | null }> {
    try {
      const row = await postgresClient.queryOne<{ log_file: string | null; training_file: string | null }>(`
        SELECT log_file, training_file FROM ${ ConversationHistoryModel.TABLE }
        WHERE id = $1
      `, [id]);
      return row ?? { log_file: null, training_file: null };
    } catch (err) {
      console.error('[ConversationHistoryModel] Failed to get file associations:', err);
      return { log_file: null, training_file: null };
    }
  }
}

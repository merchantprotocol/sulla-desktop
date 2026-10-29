// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// conversationHistoryIpc.ts — Electron IPC bridge for conversation history.
// Registers ipcMain handlers so the renderer can record, query, and clear
// conversation history entries stored in PostgreSQL via ConversationHistoryModel.

import fs from 'node:fs';

import { ipcMain } from 'electron';

import { postgresClient } from '@pkg/agent/database/PostgresClient';
import { ConversationHistoryModel } from '@pkg/agent/database/models/ConversationHistoryModel';
import type { RecordConversationInput, ConversationHistoryRecord } from '@pkg/agent/database/models/ConversationHistoryModel';
import mainEvents from '@pkg/main/mainEvents';
import { enqueueSyncOp } from '@pkg/main/sync/syncQueue';
import Logging from '@pkg/utils/logging';

const console = Logging.background;

/**
 * Delete associated files for a set of history records.
 * Best-effort — files may already be gone.
 *
 * Deletes each record's log_file (~/sulla/logs/).
 */
async function cleanupFiles(records: ConversationHistoryRecord[]): Promise<void> {
  for (const record of records) {
    // Always clean up log files
    if (record.log_file) {
      try {
        await fs.promises.unlink(record.log_file);
      } catch {
        // File may already be removed — ignore
      }
    }
  }
}

/**
 * Initialize conversation history IPC handlers.
 */
export function initConversationHistoryIpc(): void {
  // ── Fire-and-forget events (renderer → main) ──

  ipcMain.on('conversation-history:record', (_event, entry) => {
    const input: RecordConversationInput = {
      id:        entry.id,
      type:      entry.type,
      thread_id: entry.thread_id,
      title:     entry.title,
      url:       entry.url,
      favicon:   entry.favicon,
      tab_id:    entry.tab_id,
      status:    entry.status ?? 'active',
    };

    ConversationHistoryModel.recordConversation(input)
      .catch(err => console.error('[ConversationHistoryIpc] Failed to record:', err));
  });

  ipcMain.on('conversation-history:link-threads', (_event, links: { id: string; threadId: string }[]) => {
    if (!Array.isArray(links)) return;
    ConversationHistoryModel.linkThreads(links)
      .catch(err => console.error('[ConversationHistoryIpc] Failed to link threads:', err));
  });

  ipcMain.on('conversation-history:close', (_event, id: string) => {
    ConversationHistoryModel.closeConversation(id)
      .catch(err => console.error('[ConversationHistoryIpc] Failed to close:', err));
  });

  ipcMain.on('conversation-history:clear', async(_event, olderThan?: string) => {
    try {
      const cutoff = olderThan ? new Date(olderThan) : undefined;
      const deleted = await ConversationHistoryModel.clearHistory(cutoff);

      await cleanupFiles(deleted);

      // Notify renderer that history was cleared
      mainEvents.emit('conversation-history:cleared' as any, olderThan);

      // Trigger menu rebuild
      mainEvents.emit('conversation-history:changed' as any);

      console.log(`[ConversationHistoryIpc] Cleared ${ deleted.length } history entries`);
    } catch (err) {
      console.error('[ConversationHistoryIpc] Failed to clear history:', err);
    }
  });

  // ── Invoke handlers (renderer → main, with return value) ──

  ipcMain.handle('conversation-history:list', async(_event, options?: { view?: 'active' | 'archived' | 'deleted'; limit?: number; type?: string }) => {
    return await ConversationHistoryModel.list(options?.view, options?.limit, options?.type as any);
  });

  ipcMain.handle('conversation-history:update', async(_event, id: string, patch: { title?: string; pinned?: boolean; archived?: boolean; deleted?: boolean }) => {
    const updated = await ConversationHistoryModel.update(id, patch);
    if (updated?.type === 'chat') {
      const syncId = updated.thread_id || updated.id;
      const rows = await postgresClient.query<{ id: string }>(
        `UPDATE claude_conversations
            SET title = CASE WHEN $2::boolean THEN $3 ELSE title END,
                pinned = COALESCE($4, pinned),
                pinned_at = CASE WHEN $4::boolean IS NULL THEN pinned_at WHEN $4 THEN now() ELSE NULL END,
                archived = COALESCE($5, archived),
                archived_at = CASE WHEN $5::boolean IS NULL THEN archived_at WHEN $5 THEN now() ELSE NULL END,
                deleted_at = CASE WHEN $6::boolean IS NULL THEN deleted_at WHEN $6 THEN now() ELSE NULL END,
                updated_at = now()
          WHERE id = $1 OR id = $7
          RETURNING id`,
        [syncId, patch.title !== undefined, patch.title?.trim() ?? null, patch.pinned ?? null, patch.archived ?? null, patch.deleted ?? null, updated.id],
      );
      await Promise.all(rows.map(row => enqueueSyncOp('claude_conversation', { id: row.id }, patch.deleted ? 'delete' : 'upsert')));
    }
    mainEvents.emit('conversation-history:changed' as any);
    return updated;
  });

  ipcMain.handle('conversation-history:get-recent', async(_event, limit?: number, type?: string) => {
    try {
      return await ConversationHistoryModel.getRecent(
        limit ?? 50,
        type as any,
      );
    } catch (err) {
      console.error('[ConversationHistoryIpc] Failed to get recent:', err);
      return [];
    }
  });

  ipcMain.handle('conversation-history:search', async(_event, query: string, options?: { view?: 'active' | 'archived' | 'deleted'; type?: string }) => {
    try {
      return options ? await ConversationHistoryModel.searchView(query, options.view, options.type as any) : await ConversationHistoryModel.search(query);
    } catch (err) {
      console.error('[ConversationHistoryIpc] Failed to search:', err);
      return [];
    }
  });

  ipcMain.handle('conversation-history:get-by-date-range', async(_event, from: string, to: string) => {
    try {
      return await ConversationHistoryModel.getByDateRange(new Date(from), new Date(to));
    } catch (err) {
      console.error('[ConversationHistoryIpc] Failed to get by date range:', err);
      return [];
    }
  });

  ipcMain.handle('conversation-history:delete', async(_event, id: string) => {
    try {
      // Recoverable soft delete: preserve transcript, thread state, and log file.
      await ConversationHistoryModel.deleteConversation(id);

      // Trigger menu rebuild
      mainEvents.emit('conversation-history:changed' as any);
    } catch (err) {
      console.error('[ConversationHistoryIpc] Failed to delete:', err);
    }
  });

  // ── Menu-triggered clear requests ──

  mainEvents.on('conversation-history:clear-request' as any, async(...args: unknown[]) => {
    const olderThan = args[0] as string | undefined;

    try {
      const cutoff = olderThan ? new Date(olderThan) : undefined;
      const deleted = await ConversationHistoryModel.clearHistory(cutoff);

      await cleanupFiles(deleted);

      // Notify all renderer windows
      const { BrowserWindow } = await import('electron');

      for (const win of BrowserWindow.getAllWindows()) {
        try {
          if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
            win.webContents.send('conversation-history:cleared', olderThan);
          }
        } catch {
          // Window destroyed between check and send
        }
      }

      // Trigger menu rebuild
      mainEvents.emit('conversation-history:changed' as any);

      console.log(`[ConversationHistoryIpc] Menu-triggered clear: ${ deleted.length } entries removed`);
    } catch (err) {
      console.error('[ConversationHistoryIpc] Failed to clear history (menu):', err);
    }
  });

  console.log('[ConversationHistoryIpc] IPC bridge initialized');
}

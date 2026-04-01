// conversationHistoryIpc.ts — Electron IPC bridge for conversation history.
// Registers ipcMain handlers so the renderer can record, query, and clear
// conversation history entries stored in PostgreSQL via ConversationHistoryModel.

import fs from 'node:fs';

import { ipcMain } from 'electron';
import Logging from '@pkg/utils/logging';
import { ConversationHistoryModel } from '@pkg/agent/database/models/ConversationHistoryModel';
import type { RecordConversationInput, ConversationHistoryRecord } from '@pkg/agent/database/models/ConversationHistoryModel';
import mainEvents from '@pkg/main/mainEvents';

const console = Logging.background;

/**
 * Delete associated log/training files for a set of history records.
 * Best-effort — files may already be gone.
 */
async function cleanupFiles(records: ConversationHistoryRecord[]): Promise<void> {
  for (const record of records) {
    for (const filePath of [record.log_file, record.training_file]) {
      if (!filePath) continue;
      try {
        await fs.promises.unlink(filePath);
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
      id:      entry.id,
      type:    entry.type,
      title:   entry.title,
      url:     entry.url,
      favicon: entry.favicon,
      tab_id:  entry.tab_id,
      status:  entry.status ?? 'active',
    };

    ConversationHistoryModel.recordConversation(input)
      .catch(err => console.error('[ConversationHistoryIpc] Failed to record:', err));
  });

  ipcMain.on('conversation-history:close', (_event, id: string) => {
    ConversationHistoryModel.closeConversation(id)
      .catch(err => console.error('[ConversationHistoryIpc] Failed to close:', err));
  });

  ipcMain.on('conversation-history:clear', async(_event, olderThan?: string) => {
    try {
      const cutoff = olderThan ? new Date(olderThan) : undefined;
      const deleted = await ConversationHistoryModel.clearHistory(cutoff);

      // Clean up associated files
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

  ipcMain.handle('conversation-history:search', async(_event, query: string) => {
    try {
      return await ConversationHistoryModel.search(query);
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
      // Retrieve file paths before deleting the record
      const associations = await ConversationHistoryModel.getFileAssociations(id);

      await ConversationHistoryModel.deleteConversation(id);

      // Clean up files
      for (const filePath of [associations.log_file, associations.training_file]) {
        if (!filePath) continue;
        try {
          await fs.promises.unlink(filePath);
        } catch {
          // Already gone
        }
      }

      // Trigger menu rebuild
      mainEvents.emit('conversation-history:changed' as any);
    } catch (err) {
      console.error('[ConversationHistoryIpc] Failed to delete:', err);
    }
  });

  // ── Menu-triggered clear requests ──

  mainEvents.on('conversation-history:clear-request' as any, async(olderThan?: string) => {
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

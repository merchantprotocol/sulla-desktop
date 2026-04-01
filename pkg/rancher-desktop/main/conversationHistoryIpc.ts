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
 * Delete associated files for a set of history records.
 * Best-effort — files may already be gone.
 *
 * By default only log_file (~/sulla/logs/) is deleted.
 *
 * Training files (~/sulla/conversations/) are NEVER deleted unless
 * includeTrainingData is explicitly true. Training data has its own
 * lifecycle (capture → preprocess → train → archive to processed/)
 * and is used for fine-tuning the local model. Deleting it would
 * destroy irreplaceable training data.
 */
async function cleanupFiles(
  records: ConversationHistoryRecord[],
  includeTrainingData = false,
): Promise<void> {
  for (const record of records) {
    // Always clean up log files
    if (record.log_file) {
      try {
        await fs.promises.unlink(record.log_file);
      } catch {
        // File may already be removed — ignore
      }
    }

    // Training files only when explicitly requested
    if (includeTrainingData && record.training_file) {
      try {
        await fs.promises.unlink(record.training_file);
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

  ipcMain.on('conversation-history:clear', async(_event, olderThan?: string, includeTrainingData?: boolean) => {
    try {
      const cutoff = olderThan ? new Date(olderThan) : undefined;
      const deleted = await ConversationHistoryModel.clearHistory(cutoff);

      await cleanupFiles(deleted, includeTrainingData ?? false);

      // Notify renderer that history was cleared
      mainEvents.emit('conversation-history:cleared' as any, olderThan);

      // Trigger menu rebuild
      mainEvents.emit('conversation-history:changed' as any);

      console.log(`[ConversationHistoryIpc] Cleared ${ deleted.length } history entries (includeTrainingData=${ !!includeTrainingData })`);
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

  ipcMain.handle('conversation-history:delete', async(_event, id: string, includeTrainingData?: boolean) => {
    try {
      const associations = await ConversationHistoryModel.getFileAssociations(id);

      await ConversationHistoryModel.deleteConversation(id);

      // Clean up log file
      if (associations.log_file) {
        try {
          await fs.promises.unlink(associations.log_file);
        } catch {
          // Already gone
        }
      }

      // Training file only when explicitly requested
      if (includeTrainingData && associations.training_file) {
        try {
          await fs.promises.unlink(associations.training_file);
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

  mainEvents.on('conversation-history:clear-request' as any, async(...args: unknown[]) => {
    const olderThan = args[0] as string | undefined;
    const includeTrainingData = (args[1] as boolean) ?? false;

    try {
      const cutoff = olderThan ? new Date(olderThan) : undefined;
      const deleted = await ConversationHistoryModel.clearHistory(cutoff);

      await cleanupFiles(deleted, includeTrainingData);

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

      console.log(`[ConversationHistoryIpc] Menu-triggered clear: ${ deleted.length } entries removed (includeTrainingData=${ includeTrainingData })`);
    } catch (err) {
      console.error('[ConversationHistoryIpc] Failed to clear history (menu):', err);
    }
  });

  console.log('[ConversationHistoryIpc] IPC bridge initialized');
}

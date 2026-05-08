// chatMessagesIpc.ts — Electron IPC bridge for persistent chat message storage.
// Handles save/load of full thread state to/from PostgreSQL as a fallback
// when localStorage is evicted due to size limits.

import { ipcMain } from 'electron';
import { ChatMessageModel } from '@pkg/agent/database/models/ChatMessageModel';
import Logging from '@pkg/utils/logging';

const console = Logging.background;

/**
 * Initialize chat messages IPC handlers.
 */
export function initChatMessagesIpc(): void {
  // Ensure the table exists (lazy init on first use)
  ChatMessageModel.ensureTable().catch(err => {
    console.error('[ChatMessagesIpc] Failed to ensure table on init:', err);
  });

  // ── Invoke handlers (renderer → main, with return value) ──

  ipcMain.handle('chat-messages:save', async(_event, id: string, state: any) => {
    try {
      await ChatMessageModel.saveThreadState(id, state);
      return { success: true };
    } catch (err) {
      console.error('[ChatMessagesIpc] Failed to save thread state:', err);
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('chat-messages:load', async(_event, id: string) => {
    try {
      const state = await ChatMessageModel.loadThreadState(id);
      return { success: true, data: state };
    } catch (err) {
      console.error('[ChatMessagesIpc] Failed to load thread state:', err);
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('chat-messages:delete', async(_event, id: string) => {
    try {
      await ChatMessageModel.deleteThreadState(id);
      return { success: true };
    } catch (err) {
      console.error('[ChatMessagesIpc] Failed to delete thread state:', err);
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('chat-messages:message-count', async(_event, id: string) => {
    try {
      const count = await ChatMessageModel.getMessageCount(id);
      return { success: true, count };
    } catch (err) {
      console.error('[ChatMessagesIpc] Failed to get message count:', err);
      return { success: false, error: String(err), count: 0 };
    }
  });

  console.log('[ChatMessagesIpc] IPC bridge initialized');
}

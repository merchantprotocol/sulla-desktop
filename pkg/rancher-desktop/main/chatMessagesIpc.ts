// chatMessagesIpc.ts — Electron IPC bridge for durable chat transcripts.
// Thread state is persisted to the unified conversations store:
// conversation_history (header + non-message thread state) and
// conversation_messages (one row per message, original UI message in payload).
// Channel names and return shapes are unchanged so the renderer needs no edit.

import { ipcMain } from 'electron';

import { ConversationThreadStore } from '@pkg/agent/database/models/ConversationThreadStore';
import Logging from '@pkg/utils/logging';

const console = Logging.background;

/**
 * Initialize chat messages IPC handlers.
 */
export function initChatMessagesIpc(): void {
  // ── Invoke handlers (renderer → main, with return value) ──

  ipcMain.handle('chat-messages:save', async(_event, id: string, state: any) => {
    try {
      await ConversationThreadStore.saveThreadState(id, state);
      return { success: true };
    } catch (err) {
      console.error('[ChatMessagesIpc] Failed to save thread state:', err);
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('chat-messages:load', async(_event, id: string) => {
    try {
      const state = await ConversationThreadStore.loadThreadState(id);
      return { success: true, data: state };
    } catch (err) {
      console.error('[ChatMessagesIpc] Failed to load thread state:', err);
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('chat-messages:delete', async(_event, id: string) => {
    try {
      await ConversationThreadStore.deleteThreadState(id);
      return { success: true };
    } catch (err) {
      console.error('[ChatMessagesIpc] Failed to delete thread state:', err);
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('chat-messages:message-count', async(_event, id: string) => {
    try {
      const count = await ConversationThreadStore.getMessageCount(id);
      return { success: true, count };
    } catch (err) {
      console.error('[ChatMessagesIpc] Failed to get message count:', err);
      return { success: false, error: String(err), count: 0 };
    }
  });

  console.log('[ChatMessagesIpc] IPC bridge initialized');
}

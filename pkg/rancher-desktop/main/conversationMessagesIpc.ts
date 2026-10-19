// conversationMessagesIpc.ts — IPC bridge for the unified conversation_messages store.

import { ipcMain } from 'electron';

import {
  ConversationMessagesModel,
  type AppendConversationMessageInput,
  type ListConversationMessagesOptions,
} from '@pkg/agent/database/models/ConversationMessagesModel';
import Logging from '@pkg/utils/logging';

const console = Logging.background;

export function initConversationMessagesIpc(): void {
  ipcMain.handle('conversation-messages:append', async(_event, input: AppendConversationMessageInput | AppendConversationMessageInput[]) => {
    try {
      await ConversationMessagesModel.appendMany(Array.isArray(input) ? input : [input]);
      return { success: true };
    } catch (err) {
      console.error('[ConversationMessagesIpc] append failed:', err);
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('conversation-messages:list', async(_event, conversationId: string, opts?: ListConversationMessagesOptions) => {
    try {
      const data = await ConversationMessagesModel.list(conversationId, opts);
      return { success: true, data };
    } catch (err) {
      console.error('[ConversationMessagesIpc] list failed:', err);
      return { success: false, error: String(err), data: [] };
    }
  });

  ipcMain.handle('conversation-messages:count', async(_event, conversationId: string) => {
    try {
      const data = await ConversationMessagesModel.count(conversationId);
      return { success: true, data };
    } catch (err) {
      console.error('[ConversationMessagesIpc] count failed:', err);
      return { success: false, error: String(err), data: 0 };
    }
  });
}

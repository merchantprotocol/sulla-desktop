// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// conversationMessagesIpc.ts — IPC bridge for the unified conversation_messages store.

import type { IpcController, IpcRegistrar } from './ipc/IpcController';
import type { AppendConversationMessageInput, ListConversationMessagesOptions } from '@pkg/agent/database/models/ConversationMessagesModel';

export interface ConversationMessagesStore {
  appendMany(input: AppendConversationMessageInput[]): Promise<unknown>;
  list(conversationId: string, opts?: ListConversationMessagesOptions): Promise<unknown[]>;
  count(conversationId: string): Promise<number>;
}

export interface IpcErrorLogger {
  error(...args: unknown[]): void;
}

/** conversation-messages:* — append, list and count unified conversation messages. */
export class ConversationMessagesIpcController implements IpcController {
  constructor(private readonly ipc: IpcRegistrar, private readonly store: ConversationMessagesStore, private readonly log: IpcErrorLogger) {}

  register(): void {
    this.ipc.handle('conversation-messages:append', async(_event, input: AppendConversationMessageInput | AppendConversationMessageInput[]) => {
      try {
        await this.store.appendMany(Array.isArray(input) ? input : [input]);

        return { success: true };
      } catch (err) {
        this.log.error('[ConversationMessagesIpc] append failed:', err);

        return { success: false, error: String(err) };
      }
    });

    this.ipc.handle('conversation-messages:list', async(_event, conversationId: string, opts?: ListConversationMessagesOptions) => {
      try {
        const data = await this.store.list(conversationId, opts);

        return { success: true, data };
      } catch (err) {
        this.log.error('[ConversationMessagesIpc] list failed:', err);

        return { success: false, error: String(err), data: [] };
      }
    });

    this.ipc.handle('conversation-messages:count', async(_event, conversationId: string) => {
      try {
        const data = await this.store.count(conversationId);

        return { success: true, data };
      } catch (err) {
        this.log.error('[ConversationMessagesIpc] count failed:', err);

        return { success: false, error: String(err), data: 0 };
      }
    });
  }
}

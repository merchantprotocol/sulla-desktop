// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// chatMessagesIpc.ts — Electron IPC bridge for durable chat transcripts.
// Thread state is persisted to the unified conversations store:
// conversation_history (header + non-message thread state) and
// conversation_messages (one row per message, original UI message in payload).
// Channel names and return shapes are unchanged so the renderer needs no edit.

import type { IpcController, IpcRegistrar } from './ipc/IpcController';

export interface ChatThreadStatePort {
  saveThreadState(id: string, state: any): Promise<unknown>;
  loadThreadState(id: string): Promise<unknown>;
  loadMessagesBefore(id: string, beforeMessageId: string, limit: number): Promise<any[]>;
  deleteThreadState(id: string): Promise<unknown>;
  getMessageCount(id: string): Promise<number>;
}

export interface ChatMessagesLogger {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** chat-messages:* — save/load/delete thread state and count messages. */
export class ChatMessagesIpcController implements IpcController {
  constructor(private readonly ipc: IpcRegistrar, private readonly store: ChatThreadStatePort, private readonly log: ChatMessagesLogger) {}

  register(): void {
    const { store, log } = this;

    this.ipc.handle('chat-messages:save', async(_event, id: string, state: any) => {
      try {
        await store.saveThreadState(id, state);

        return { success: true };
      } catch (err) {
        log.error('[ChatMessagesIpc] Failed to save thread state:', err);

        return { success: false, error: String(err) };
      }
    });

    this.ipc.handle('chat-messages:load', async(_event, id: string) => {
      try {
        const state = await store.loadThreadState(id);

        return { success: true, data: state };
      } catch (err) {
        log.error('[ChatMessagesIpc] Failed to load thread state:', err);

        return { success: false, error: String(err) };
      }
    });

    this.ipc.handle('chat-messages:load-before', async(_event, input: { threadId: string; beforeMessageId: string; limit?: number }) => {
      try {
        const messages = await store.loadMessagesBefore(input.threadId, input.beforeMessageId, input.limit ?? 50);
        return { success: true, data: messages };
      } catch (err) {
        log.error('[ChatMessagesIpc] Failed to load older messages:', err);
        return { success: false, error: String(err), data: [] };
      }
    });

    this.ipc.handle('chat-messages:delete', async(_event, id: string) => {
      try {
        await store.deleteThreadState(id);

        return { success: true };
      } catch (err) {
        log.error('[ChatMessagesIpc] Failed to delete thread state:', err);

        return { success: false, error: String(err) };
      }
    });

    this.ipc.handle('chat-messages:message-count', async(_event, id: string) => {
      try {
        const count = await store.getMessageCount(id);

        return { success: true, count };
      } catch (err) {
        log.error('[ChatMessagesIpc] Failed to get message count:', err);

        return { success: false, error: String(err), count: 0 };
      }
    });

    log.log('[ChatMessagesIpc] IPC bridge initialized');
  }
}

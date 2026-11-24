// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { normalizeChatHeartbeatConfig, type ChatHeartbeatConfig } from '@pkg/shared/chatHeartbeat';

import type { IpcController, IpcRegistrar } from './ipc/IpcController';
import type { getChatHeartbeatService } from '@pkg/agent/services/ChatHeartbeatService';

type ChatHeartbeatService = ReturnType<typeof getChatHeartbeatService>;

interface RegisterInput {
  threadId: string;
  channel?: string;
  config?:  Partial<ChatHeartbeatConfig>;
  busy?:    boolean;
}

/** chat-heartbeat:* — per-thread heartbeat registration, config and busy state. */
export class ChatHeartbeatIpcController implements IpcController {
  /** The service is resolved at register() time, matching the old initializer. */
  constructor(private readonly ipc: IpcRegistrar, private readonly serviceFactory: () => ChatHeartbeatService) {}

  cleanThreadId(input: unknown): string {
    return typeof input === 'string' ? input.trim() : '';
  }

  register(): void {
    const service = this.serviceFactory();

    this.ipc.handle('chat-heartbeat:register', (event, input: RegisterInput) => {
      const threadId = this.cleanThreadId(input?.threadId);
      if (!threadId) return { success: false, error: 'threadId is required' };
      const send = (name: string, payload: unknown) => {
        if (!event.sender.isDestroyed()) event.sender.send(name, payload);
      };
      const status = service.register({
        threadId,
        channel:  input.channel?.trim() || 'sulla-desktop',
        config:   normalizeChatHeartbeatConfig(input.config),
        busy:     !!input.busy,
        onStatus: value => send('chat-heartbeat:status', value),
        onBeat:   value => send('chat-heartbeat:beat', value),
        onConfig: value => send('chat-heartbeat:config', { threadId, config: value }),
      });

      return { success: true, status };
    });

    this.ipc.handle('chat-heartbeat:set', (_event, input: { threadId: string; config: ChatHeartbeatConfig }) => {
      const threadId = this.cleanThreadId(input?.threadId);
      const status = service.configure(threadId, normalizeChatHeartbeatConfig(input?.config));

      return status ? { success: true, status } : { success: false, error: 'chat heartbeat is not registered' };
    });

    this.ipc.handle('chat-heartbeat:busy', (_event, input: { threadId: string; busy: boolean }) => {
      const status = service.updateBusy(this.cleanThreadId(input?.threadId), !!input?.busy);

      return { success: !!status, status };
    });

    this.ipc.handle('chat-heartbeat:unregister', (_event, threadId: string) => {
      service.unregisterFromUi(this.cleanThreadId(threadId));

      return { success: true };
    });
  }
}

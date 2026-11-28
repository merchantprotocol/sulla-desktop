// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { BackendGraphWebSocketService } from '@pkg/agent/services/BackendGraphWebSocketService';
import type { IpcController, IpcRegistrar } from './ipc/IpcController';

type ChatRunStateService = Pick<BackendGraphWebSocketService, 'hasActiveRun' | 'hasActiveRunOnAnotherChannel'>;
type AgentSenderGuard = { isAgentWebContents(sender: any): boolean };

/** Reports this thread's run state without assuming the renderer's channel owns its active run. */
export class ChatRunStateIpcController implements IpcController {
  constructor(
    private readonly ipc: IpcRegistrar,
    private readonly agentWindows: AgentSenderGuard,
    private readonly serviceFactory: () => ChatRunStateService | Promise<ChatRunStateService>,
  ) {}

  register(): void {
    this.ipc.handle('chat:run-state', async(event, channelId: string, threadId: string) => {
      if (!this.agentWindows.isAgentWebContents(event.sender)) return null;
      if (!channelId || !threadId) return false;

      const service = await this.serviceFactory();
      return service.hasActiveRun(channelId, threadId)
        || service.hasActiveRunOnAnotherChannel(channelId, threadId);
    });
  }
}

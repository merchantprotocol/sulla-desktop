// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { IpcController, IpcRegistrar } from './ipc/IpcController';

export interface AgentTabContractPort {
  acknowledgeReady(contractId: string, threadId: string): void;
  snapshot(contractId: string, threadId: string): unknown;
}

/** agent-tab:ready — a spawned agent tab reports it mounted and receives its thread snapshot. */
export class AgentTabContractIpcController implements IpcController {
  constructor(private readonly ipc: IpcRegistrar, private readonly tabs: AgentTabContractPort) {}

  register(): void {
    this.ipc.handle('agent-tab:ready', async(_event, payload: { contractId: string; threadId: string }) => {
      const contractId = String(payload?.contractId ?? '').trim();
      const threadId = String(payload?.threadId ?? '').trim();
      if (!contractId || !threadId) return { messages: [] };

      this.tabs.acknowledgeReady(contractId, threadId);

      return this.tabs.snapshot(contractId, threadId);
    });
  }
}

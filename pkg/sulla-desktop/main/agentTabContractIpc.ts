// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ipcMain } from 'electron';

import {
  acknowledgeAgentTabReady,
  getAgentTabThreadSnapshot,
} from '@pkg/agent/services/AgentTabOpener';

export function initAgentTabContractIpc(): void {
  ipcMain.handle('agent-tab:ready', async(_event, payload: { contractId: string; threadId: string }) => {
    const contractId = String(payload?.contractId ?? '').trim();
    const threadId = String(payload?.threadId ?? '').trim();
    if (!contractId || !threadId) return { messages: [] };

    acknowledgeAgentTabReady(contractId, threadId);
    return getAgentTabThreadSnapshot(contractId, threadId);
  });
}

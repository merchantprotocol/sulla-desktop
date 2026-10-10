import { ipcMain } from 'electron';

import {
  acknowledgeAgentTabReady,
  getAgentTabThreadSnapshot,
} from '@pkg/agent/services/AgentTabContractService';

export function initAgentTabContractIpc(): void {
  ipcMain.handle('agent-tab:ready', async(_event, payload: { contractId: string; threadId: string }) => {
    const contractId = String(payload?.contractId ?? '').trim();
    const threadId = String(payload?.threadId ?? '').trim();
    if (!contractId || !threadId) return { messages: [] };

    acknowledgeAgentTabReady(contractId, threadId);
    return getAgentTabThreadSnapshot(contractId, threadId);
  });
}

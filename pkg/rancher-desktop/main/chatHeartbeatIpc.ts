import { ipcMain } from 'electron';

import { getChatHeartbeatService } from '@pkg/agent/services/ChatHeartbeatService';
import { normalizeChatHeartbeatConfig, type ChatHeartbeatConfig } from '@pkg/shared/chatHeartbeat';

interface RegisterInput {
  threadId: string;
  channel?: string;
  config?:  Partial<ChatHeartbeatConfig>;
  busy?:    boolean;
}

function cleanThreadId(input: unknown): string {
  return typeof input === 'string' ? input.trim() : '';
}

export function initChatHeartbeatIpc(): void {
  const service = getChatHeartbeatService();

  ipcMain.handle('chat-heartbeat:register', (event, input: RegisterInput) => {
    const threadId = cleanThreadId(input?.threadId);
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

  ipcMain.handle('chat-heartbeat:set', (_event, input: { threadId: string; config: ChatHeartbeatConfig }) => {
    const threadId = cleanThreadId(input?.threadId);
    const status = service.configure(threadId, normalizeChatHeartbeatConfig(input?.config));
    return status ? { success: true, status } : { success: false, error: 'chat heartbeat is not registered' };
  });

  ipcMain.handle('chat-heartbeat:busy', (_event, input: { threadId: string; busy: boolean }) => {
    const status = service.updateBusy(cleanThreadId(input?.threadId), !!input?.busy);
    return { success: !!status, status };
  });

  ipcMain.handle('chat-heartbeat:unregister', (_event, threadId: string) => {
    service.unregister(cleanThreadId(threadId));
    return { success: true };
  });
}

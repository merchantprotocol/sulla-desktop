import { ipcMain } from 'electron';

import { getChatArtifactService } from '@pkg/agent/services/ChatArtifactService';
import type { ChatArtifactStatus } from '@pkg/shared/chatArtifacts';

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function initChatArtifactsIpc(): void {
  const service = getChatArtifactService();

  ipcMain.handle('chat-artifacts:list', (_event, input: { threadId: string; includeClosed?: boolean }) =>
    service.list(text(input?.threadId), !!input?.includeClosed));

  ipcMain.handle('chat-artifacts:get', (_event, input: { threadId: string; idOrName: string }) =>
    service.get(text(input?.threadId), text(input?.idOrName)));

  ipcMain.handle('chat-artifacts:save', (_event, input: {
    threadId: string;
    idOrName: string;
    content?: string;
    name?: string;
    status?: ChatArtifactStatus;
    expectedVersion?: number;
  }) => service.update(text(input?.threadId), text(input?.idOrName), {
    content: input?.content,
    name: input?.name,
    status: input?.status,
    expectedVersion: input?.expectedVersion,
    author: 'human',
  }));

  ipcMain.handle('chat-artifacts:close', (_event, input: { threadId: string; idOrName: string; expectedVersion?: number }) =>
    service.close(text(input?.threadId), text(input?.idOrName), input?.expectedVersion, 'human'));

  ipcMain.handle('chat-artifacts:focus', (_event, input: { threadId: string; idOrName: string }) =>
    service.focus(text(input?.threadId), text(input?.idOrName)));
}

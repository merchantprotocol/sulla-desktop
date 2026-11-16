// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { IpcController, IpcRegistrar } from './ipc/IpcController';
import type { getChatArtifactService } from '@pkg/agent/services/ChatArtifactService';
import type { ChatArtifactStatus } from '@pkg/shared/chatArtifacts';

type ChatArtifactService = ReturnType<typeof getChatArtifactService>;

export interface ChatArtifactsIpcDependencies {
  /** Wires Files registration into the artifact service, then returns the service (old init order). */
  service(): ChatArtifactService;
  readGuard: { run<T>(label: string, read: () => Promise<T>, fallback: T): Promise<T> };
  getArtifactById(id: string): Promise<{ threadId: string } | null | undefined>;
  getHistoryByThread(threadId: string): Promise<{ status?: string } | null | undefined>;
}

/** chat-artifacts:* — the renderer's artifact pane. */
export class ChatArtifactsIpcController implements IpcController {
  constructor(private readonly ipc: IpcRegistrar, private readonly deps: ChatArtifactsIpcDependencies) {}

  text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  register(): void {
    const service = this.deps.service();
    const text = (value: unknown) => this.text(value);

    // null = database not reachable yet: the renderer keeps what it shows and
    // reloads on `database:available` (an empty list would close open artifacts).
    this.ipc.handle('chat-artifacts:list', (_event, input: { threadId: string; includeClosed?: boolean }) =>
      this.deps.readGuard.run('chat-artifacts:list', () => service.list(text(input?.threadId), !!input?.includeClosed), null));

    this.ipc.handle('chat-artifacts:get', (_event, input: { threadId: string; idOrName: string }) =>
      service.get(text(input?.threadId), text(input?.idOrName)));

    this.ipc.handle('chat-artifacts:open-file', (_event, input: { threadId: string; fileId: string }) =>
      service.openFile(text(input?.threadId), text(input?.fileId)));

    this.ipc.handle('chat-artifacts:get-by-id', async(_event, input: { artifactId: string }) => {
      const artifact = await this.deps.getArtifactById(text(input?.artifactId));
      if (!artifact) return null;
      const foundHistory = await this.deps.getHistoryByThread(artifact.threadId);
      const history = foundHistory?.status === 'deleted' ? null : foundHistory;

      return { threadId: artifact.threadId, artifact, history };
    });

    this.ipc.handle('chat-artifacts:save', (_event, input: {
      threadId:         string;
      idOrName:         string;
      content?:         string;
      name?:            string;
      status?:          ChatArtifactStatus;
      expectedVersion?: number;
    }) => service.update(text(input?.threadId), text(input?.idOrName), {
      content:         input?.content,
      name:            input?.name,
      status:          input?.status,
      expectedVersion: input?.expectedVersion,
      author:          'human',
    }));

    this.ipc.handle('chat-artifacts:close', (_event, input: { threadId: string; idOrName: string; expectedVersion?: number }) =>
      service.close(text(input?.threadId), text(input?.idOrName), input?.expectedVersion, 'human'));

    this.ipc.handle('chat-artifacts:focus', (_event, input: { threadId: string; idOrName: string }) =>
      service.focus(text(input?.threadId), text(input?.idOrName)));

    this.ipc.handle('chat-artifacts:reopen', (_event, input: { threadId: string; idOrName: string }) =>
      service.reopen(text(input?.threadId), text(input?.idOrName), undefined, 'human'));

    this.ipc.handle('chat-artifacts:retry-files-registration', (_event, input: { threadId: string; idOrName: string }) =>
      service.retryFilesRegistration(text(input?.threadId), text(input?.idOrName)));
  }
}

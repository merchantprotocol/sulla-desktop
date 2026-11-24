// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ window: undefined as any, sent: [] as any[], listener: undefined as any }));
vi.mock('electron', () => ({ ipcMain: { once: vi.fn((_channel: string, listener: any) => { state.listener = listener; }), removeAllListeners: vi.fn() } }));
vi.mock('@pkg/window/agentWindows', () => ({ getActiveAgentWindow: () => state.window }));

import { FilesOpenWorker } from '../../../tools/files/open';
import { AgentFileOpenRoutePolicy } from '../../../tools/files/AgentFileOpenRoutePolicy';

class InlineTestWorker extends FilesOpenWorker {
  protected override async resolvePath() {
    return { collectionId: 'collection-1', fileId: 'file-1', folderPath: 'Projects/example', kind: 'file' as const };
  }
  async execute(input: any) { return this._validatedCall(input); }
}

const visibleState = { metadata: { threadId: 'thread-1', desktopChatVisible: true } } as any;

describe('FilesOpenWorker inline wiring', () => {
  beforeEach(() => {
    state.sent = [];
    state.listener = undefined;
    state.window = { webContents: { isLoading: () => false, send: vi.fn((...args: any[]) => { state.sent.push(args); queueMicrotask(() => state.listener?.({ sender: state.window.webContents }, { opened: true, tabId: 'tab-1', path: args[1]?.path, how: 'document-editor' })); }) }, focus: vi.fn() };
  });

  it('dispatches an empty-content inline file reference for visible Desktop chat', async() => {
    // risk: file access — visible chat opens a durable reference rather than a tab.
    const worker = new InlineTestWorker();
    worker.setState(visibleState);
    worker.executionContext = { thread_id: 'thread-1' } as any;
    const send = vi.fn(async(_content: string, kind: string, extras: any) => { state.sent.push([kind, extras]); return true; });
    worker.sendChatMessage = send;
    const response = await worker.execute({ path: 'Projects/example/file.md' });
    expect(response).toMatchObject({ successBoolean: true });
    expect(send).toHaveBeenCalledWith('', 'inline_file_reference', { inlineFileReference: expect.objectContaining({ content: '', thread_id: 'thread-1', reference: { file_id: 'file-1', collection_id: 'collection-1' } }) });
    expect(state.window.webContents.send).not.toHaveBeenCalled();
    expect(JSON.parse(response.responseString)).toMatchObject({ opened: true, placement: 'inline', fileId: 'file-1' });
  });

  it.each([
    ['mobile-relay', { threadId: 'thread-1', desktopChatVisible: false }],
    ['chat completions', { threadId: 'thread-1' }],
    ['sub-agent', { threadId: 'thread-1', desktopChatVisible: true, isSubAgent: true }],
    ['muted', { threadId: 'thread-1', desktopChatVisible: true, _muteWsChat: true }],
  ])('%s uses the legacy tab route', async(_name, metadata) => {
    const worker = new InlineTestWorker();
    worker.setState({ metadata } as any);
    worker.executionContext = { thread_id: 'thread-1' } as any;
    worker.sendChatMessage = vi.fn(async() => true);
    const response = await worker.execute({ path: 'Projects/example/file.md' });
    expect(response.successBoolean).toBe(true);
    expect(worker.sendChatMessage).not.toHaveBeenCalled();
    expect(state.window.webContents.send).toHaveBeenCalledWith('agent-command', expect.objectContaining({ command: 'open-files-item' }));
  });

  it('fails instead of falling back when inline delivery returns false or throws', async() => {
    // risk: irreversible UI side effect — delivery failure must be visible to the caller.
    for (const send of [vi.fn(async() => false), vi.fn(async() => { throw new Error('transport down'); })]) {
      const worker = new InlineTestWorker();
      worker.setState(visibleState);
      worker.executionContext = { thread_id: 'thread-1' } as any;
      worker.sendChatMessage = send as any;
      await expect(worker.execute({ path: 'Projects/example/file.md' })).rejects.toThrow(/not delivered|transport down/);
      expect(state.window.webContents.send).not.toHaveBeenCalled();
    }
  });

  it('routes explicit tab placement to legacy tab and rejects tool-supplied thread ids', () => {
    const policy = new AgentFileOpenRoutePolicy();
    expect(policy.route('tab', { threadId: 'thread-1', executionThreadId: 'thread-1', hasChatTransport: true, isHumanVisibleChatEligible: true, isChatMuted: false, isSubconsciousSilent: false }).kind).toBe('legacy-tab');
    expect(policy.route('inline', { threadId: 'thread-1', executionThreadId: 'other', hasChatTransport: true, isHumanVisibleChatEligible: true, isChatMuted: false, isSubconsciousSilent: false }).kind).toBe('legacy-tab');
  });
});

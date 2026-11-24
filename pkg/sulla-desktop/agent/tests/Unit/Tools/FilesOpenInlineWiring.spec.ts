// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ window: undefined as any, sent: [] as any[], listener: undefined as any, sender: undefined as any, tabHostOwner: undefined as any }));
vi.mock('electron', () => ({ ipcMain: { once: vi.fn((_channel: string, listener: any) => { state.listener = listener; }), removeAllListeners: vi.fn() } }));
vi.mock('@pkg/window/agentWindows', () => ({ getActiveAgentWindow: () => state.window }));
vi.mock('@pkg/window/agentWindowTrust', () => ({ agentWindowFromSender: (sender: any) => (sender === state.tabHostOwner?.view ? state.tabHostOwner.window : null) }));

import { FilesOpenWorker } from '../../../tools/files/open';
import { AgentFileOpenRoutePolicy } from '../../../tools/files/AgentFileOpenRoutePolicy';
import { ToolSessionChatTransport } from '../../../tools/ToolSessionChatTransport';
import { filesToolManifests } from '../../../tools/files/manifests';

const openSchema = filesToolManifests.find(manifest => manifest.name === 'open')!.schemaDef;

class InlineTestWorker extends FilesOpenWorker {
  protected override async resolvePath() {
    return { collectionId: 'collection-1', fileId: 'file-1', folderPath: 'Projects/example', kind: 'file' as const };
  }
  constructor() { super(); this.schemaDef = openSchema; }
  // Production input path: manifest defaults are applied before routing.
  async execute(input: any) { return this._validatedCall(this.parseInput(input)); }
}

const visibleMetadata = { threadId: 'thread-1', wsChannel: 'sulla-desktop', desktopChatVisible: true };

function ineligibleTabWorker(metadata: Record<string, unknown>) {
  const worker = new InlineTestWorker();
  worker.setState({ metadata } as any);
  worker.sendChatMessage = vi.fn(async() => true);
  return worker;
}

describe('files/open inline eligibility and trust', () => {
  beforeEach(() => {
    state.sent = [];
    state.listener = undefined;
    state.tabHostOwner = undefined;
    state.window = { webContents: { isLoading: () => false, send: vi.fn((...args: any[]) => { state.sent.push(args); queueMicrotask(() => state.listener?.({ sender: state.sender ?? state.window.webContents }, { opened: true, tabId: 'tab-1', path: args[1]?.path, how: 'file-manager-viewer' })); }) }, focus: vi.fn() };
    state.sender = undefined;
  });

  it('a CLI-session call from a visible Desktop chat (no execution context) posts an inline card to the bound thread', async() => {
    // risk: policy — claude-code/codex chat agents call through a tool session with no container execution context.
    const bus = { send: vi.fn(async() => true) };
    const worker = new InlineTestWorker();
    worker.name = 'open';
    worker.metadata.category = 'files';
    worker.setState({ metadata: { ...visibleMetadata } } as any);
    new ToolSessionChatTransport(async() => bus).attach(worker, worker.state as any);
    const response = await worker.execute({ path: 'Projects/example/file.md' });
    expect(JSON.parse(response.responseString)).toMatchObject({ opened: true, placement: 'inline', fileId: 'file-1' });
    expect(bus.send).toHaveBeenCalledWith('sulla-desktop', { type: 'assistant_message', data: expect.objectContaining({ kind: 'inline_file_reference', thread_id: 'thread-1', inlineFileReference: expect.objectContaining({ thread_id: 'thread-1', reference: { file_id: 'file-1', collection_id: 'collection-1' } }) }) });
    expect(state.window.webContents.send).not.toHaveBeenCalled();
  });

  it('the session transport is only attached to files/open', () => {
    const transport = new ToolSessionChatTransport(async() => ({ send: async() => true }));
    const other: any = { name: 'search', metadata: { category: 'files' } };
    transport.attach(other, { metadata: { ...visibleMetadata } } as any);
    expect(other.sendChatMessage).toBeUndefined();
  });

  it.each([
    ['mobile relay', { threadId: 'thread-1', desktopChatVisible: false }, 'not-visible-desktop-chat'],
    ['chat completions API', { threadId: 'thread-1' }, 'not-visible-desktop-chat'],
    ['sub-agent', { ...visibleMetadata, isSubAgent: true }, 'sub-agent'],
    ['relayed turn', { ...visibleMetadata, relayed: true }, 'relayed-turn'],
    ['muted run', { ...visibleMetadata, _muteWsChat: true }, 'chat-muted'],
  ])('%s: default placement opens the tab', async(_name, metadata, _reason) => {
    const worker = ineligibleTabWorker(metadata);
    const response = await worker.execute({ path: 'Projects/example/file.md' });
    expect(response.successBoolean).toBe(true);
    expect(worker.sendChatMessage).not.toHaveBeenCalled();
    expect(state.window.webContents.send).toHaveBeenCalledWith('agent-command', expect.objectContaining({ command: 'open-files-item' }));
  });

  it.each([
    ['hidden job', { threadId: 'thread-1' }, /visible Desktop chat.*not a visible Desktop chat turn/],
    ['sub-agent', { ...visibleMetadata, isSubAgent: true }, /this call came from a sub-agent/],
  ])('%s: explicit inline fails immediately and never opens a tab', async(_name, metadata, message) => {
    const worker = ineligibleTabWorker(metadata);
    await expect(worker.execute({ path: 'Projects/example/file.md', placement: 'inline' })).rejects.toThrow(message);
    expect(state.window.webContents.send).not.toHaveBeenCalled();
  });

  it('an execution identity for another thread is never inline', () => {
    const policy = new AgentFileOpenRoutePolicy();
    const context = { threadId: 'thread-1', executionThreadId: 'other', hasChatTransport: true, isDesktopChatVisible: true, isSubAgent: false, isRelayed: false, isChatMuted: false, isSubconsciousSilent: false };
    expect(policy.route(undefined, context)).toMatchObject({ kind: 'legacy-tab', reason: 'thread-mismatch' });
    expect(policy.route('tab', { ...context, executionThreadId: 'thread-1' }).kind).toBe('legacy-tab');
  });

  it('accepts the File Manager acknowledgement from the window tab host and rejects foreign senders', async() => {
    // risk: policy — the ack must come from the target window, including its own tab-host view.
    const view = { id: 'tab-host' };
    state.tabHostOwner = { view, window: state.window };
    state.sender = view;
    await expect(ineligibleTabWorker({ threadId: 'thread-1' }).execute({ path: 'Projects/example/data.csv' })).resolves.toMatchObject({ successBoolean: true });
    state.sender = { id: 'foreign' };
    await expect(ineligibleTabWorker({ threadId: 'thread-1' }).execute({ path: 'Projects/example/data.csv' })).rejects.toThrow(/untrusted/);
  });

  it('fails instead of falling back when inline delivery returns false or throws', async() => {
    // risk: irreversible UI side effect — delivery failure must be visible to the caller.
    for (const send of [vi.fn(async() => false), vi.fn(async() => { throw new Error('transport down'); })]) {
      const worker = new InlineTestWorker();
      worker.setState({ metadata: { ...visibleMetadata } } as any);
      worker.sendChatMessage = send as any;
      await expect(worker.execute({ path: 'Projects/example/file.md' })).rejects.toThrow(/not delivered|transport down/);
      expect(state.window.webContents.send).not.toHaveBeenCalled();
    }
  });
});

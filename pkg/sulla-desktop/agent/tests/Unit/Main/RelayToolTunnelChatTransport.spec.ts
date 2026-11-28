// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  send: vi.fn(async(_channel: string, _message: unknown) => true),
  graphState: undefined as any,
  graphGet: vi.fn(),
  tool: undefined as any,
  activeWindow: undefined as any,
  replyListener: undefined as any,
  toolRegistry: {
    resolveRegisteredName: vi.fn(),
    getExecutionTarget: vi.fn(),
    createTool: vi.fn(),
  },
}));

vi.mock('@pkg/agent/services/WebSocketClientService', () => ({
  getWebSocketClientService: () => ({ send: fixture.send }),
}));
vi.mock('@pkg/agent/services/GraphRegistry', () => ({
  GraphRegistry: { get: fixture.graphGet },
}));
vi.mock('@pkg/agent/tools', () => ({ toolRegistry: fixture.toolRegistry }));
vi.mock('@pkg/agent/services/AgentContainerRuntimeRegistry', () => ({
  containerRuntimeForExecution: () => undefined,
  withAgentContainerRuntime: (_runtime: unknown, run: () => unknown) => run(),
}));
vi.mock('@pkg/main/chatCompletionsServer', () => ({ getChatCompletionsServer: () => ({ getApiToken: () => '' }) }));
vi.mock('@pkg/main/deviceIdentity', () => ({ getDesktopDeviceId: vi.fn() }));
vi.mock('@pkg/main/sullaCloudAuth', () => ({ getCurrentUserId: vi.fn() }));
vi.mock('@pkg/runtime/relayTunnelClient', () => ({ RelayToolTunnel: class {} }));
vi.mock('@pkg/utils/logging', () => ({ default: { background: console } }));
vi.mock('@pkg/vault-broker', () => ({ usesContainerVaultAuthority: () => false, configuredVaultBrokerProvider: {} }));
vi.mock('@pkg/utils/instance', () => ({ loopbackOrigin: () => 'http://localhost' }));
vi.mock('../../../files/containerClient', () => ({ filesContainerRequest: vi.fn() }));
vi.mock('electron', () => ({
  ipcMain: {
    once: vi.fn((_channel: string, listener: typeof fixture.replyListener) => { fixture.replyListener = listener; }),
    removeListener: vi.fn((_channel: string, listener: typeof fixture.replyListener) => {
      if (fixture.replyListener === listener) fixture.replyListener = undefined;
    }),
    removeAllListeners: vi.fn(),
  },
}));
vi.mock('@pkg/window/agentWindows', () => ({ getActiveAgentWindow: () => fixture.activeWindow }));
vi.mock('@pkg/window/agentWindowTrust', () => ({ agentWindowFromSender: () => null }));

import { FilesOpenWorker } from '@pkg/agent/tools/files/open';
import { filesToolManifests } from '@pkg/agent/tools/files/manifests';
import { toolDecisionPort, UnavailableToolDecisionPort } from '@pkg/agent/tools/toolDecisionPort';
import { executeThroughRegistry } from '@pkg/main/relayToolTunnel';

const openManifest = filesToolManifests.find(manifest => manifest.name === 'open')!;
const resolvedFile = { collectionId: 'collection-1', fileId: 'file-1', folderPath: 'Projects/example', kind: 'file' as const };

class ResolvedFilesOpenWorker extends FilesOpenWorker {
  constructor() {
    super();
    this.schemaDef = openManifest.schemaDef;
    this.name = openManifest.name;
    this.metadata.category = 'files';
    this.metadata.operationTypes = ['read'];
  }

  protected override async resolvePath() { return resolvedFile }
}

function installFileManagerWindow() {
  const webContents: any = {
    isLoading: () => false,
    once: vi.fn(),
    send: vi.fn((_channel: string, payload: any) => {
      queueMicrotask(() => fixture.replyListener?.({ sender: webContents }, {
        opened: true, tabId: 'files-tab-1', path: payload.path, how: 'file-manager-viewer',
      }));
    }),
  };
  fixture.activeWindow = { webContents, focus: vi.fn() };
  return fixture.activeWindow;
}

function graphState(threadId: string, metadata: Record<string, unknown> = {}) {
  return { metadata: { threadId, wsChannel: 'sulla-desktop', ...metadata } } as any;
}

function context(threadId: string) {
  // Represents RelayToolTunnel's context decoded from the signed capability, not caller arguments.
  return { v: 1, iss: 'sulla-tools', aud: 'sulla-tools', sub: 'owner', thread_id: threadId, scopes: [], iat: 1, exp: 2, jti: 'jti', request_id: 'request' } as any;
}

async function openThroughRelay(threadId: string, args: Record<string, unknown>) {
  fixture.tool = new ResolvedFilesOpenWorker();
  vi.spyOn(fixture.tool, 'invoke');
  fixture.toolRegistry.resolveRegisteredName.mockReturnValue('open');
  fixture.toolRegistry.getExecutionTarget.mockReturnValue('desktop-local');
  fixture.toolRegistry.createTool.mockImplementation(async() => fixture.tool);
  return executeThroughRegistry(context(threadId), 'files', 'open', args, new AbortController().signal);
}

describe('relay CLI files/open chat transport', () => {
  beforeEach(() => {
    toolDecisionPort.register({ requiresApproval: async() => false, request: async() => { throw new Error('not expected in this test') } });
    fixture.graphState = undefined;
    fixture.graphGet.mockReset();
    fixture.graphGet.mockImplementation((threadId: string) => fixture.graphState?.metadata?.threadId === threadId
      ? { graph: {}, state: fixture.graphState }
      : null);
    fixture.tool = undefined;
    fixture.activeWindow = undefined;
    fixture.replyListener = undefined;
    fixture.send.mockReset();
    fixture.send.mockResolvedValue(true);
    fixture.toolRegistry.resolveRegisteredName.mockReset();
    fixture.toolRegistry.getExecutionTarget.mockReset();
    fixture.toolRegistry.createTool.mockReset();
  });

  afterEach(() => {
    toolDecisionPort.register(new UnavailableToolDecisionPort());
    fixture.activeWindow = undefined;
    fixture.replyListener = undefined;
  });

  it('posts a real inline file card to the verified graph channel, ignoring a caller-supplied thread_id', async() => {
    // risk: tenant isolation — a CLI caller cannot redirect file content to another thread with tool arguments.
    fixture.graphState = graphState('verified-thread', { desktopChatVisible: true });
    const args = { path: 'Projects/example/file.md', placement: 'inline', thread_id: 'attacker-thread' };

    const result = await openThroughRelay('verified-thread', args);

    expect(result.success).toBe(true);
    expect(fixture.graphGet).toHaveBeenCalledExactlyOnceWith('verified-thread');
    expect(fixture.graphGet).not.toHaveBeenCalledWith('attacker-thread');
    expect(fixture.tool.invoke).toHaveBeenCalledWith(args, fixture.graphState);
    expect(fixture.send).toHaveBeenCalledExactlyOnceWith('sulla-desktop', {
      type: 'assistant_message',
      data: expect.objectContaining({
        kind: 'inline_file_reference',
        thread_id: 'verified-thread',
        inlineFileReference: expect.objectContaining({ thread_id: 'verified-thread', reference: { file_id: 'file-1', collection_id: 'collection-1' } }),
      }),
    });
    expect(fixture.activeWindow).toBeUndefined();
  });

  it.each([
    ['hidden sub-agent', { desktopChatVisible: true, isSubAgent: true }],
    ['mobile relay turn', { desktopChatVisible: false, relayed: true }],
    ['relayed turn with stale visible flag', { desktopChatVisible: true, relayed: true }],
    ['chat-completions API call', { desktopChatVisible: false }],
  ])('%s keeps the real relay file open out of inline chat and falls back to the Files tab', async(label, metadata) => {
    // risk: privacy — hidden, relayed, and headless API calls must never disclose file content into a visible chat.
    const threadId = `${label}-thread`;
    fixture.graphState = graphState(threadId, metadata);
    const window = installFileManagerWindow();

    const result = await openThroughRelay(threadId, { path: 'Projects/example/file.md', focus: false });

    expect(result.success).toBe(true);
    expect(JSON.parse(result.result as string)).toMatchObject({ opened: true, tabId: 'files-tab-1' });
    expect(fixture.send).not.toHaveBeenCalled();
    expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith('agent-command', expect.objectContaining({ command: 'open-files-item', fileId: 'file-1' }));
  });

  it.each([
    ['hidden sub-agent', { desktopChatVisible: true, isSubAgent: true }],
    ['mobile relay turn', { desktopChatVisible: false, relayed: true }],
    ['relayed turn with stale visible flag', { desktopChatVisible: true, relayed: true }],
    ['chat-completions API call', { desktopChatVisible: false }],
  ])('%s rejects an explicit inline request without posting a card', async(label, metadata) => {
    // risk: privacy — an explicit placement cannot override server-stamped visibility or delegation state.
    const threadId = `${label}-thread`;
    fixture.graphState = graphState(threadId, metadata);

    const result = await openThroughRelay(threadId, { path: 'Projects/example/file.md', placement: 'inline' });

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/visible Desktop chat/i);
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.activeWindow).toBeUndefined();
  });

  it('fails closed when the verified relay thread has no live GraphRegistry state', async() => {
    // risk: stale identity — a session cannot authorize inline delivery after its graph leaves the live registry.
    const result = await openThroughRelay('expired-thread', {
      path: 'Projects/example/file.md', placement: 'inline', thread_id: 'visible-attacker-thread',
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/not a visible Desktop chat turn/i);
    expect(fixture.graphGet).toHaveBeenCalledExactlyOnceWith('expired-thread');
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it('keeps CLI publish-approval cards bound to the verified relay graph', async() => {
    // risk: consent integrity — publish approval must reach the graph that owns its DecisionService record.
    fixture.graphState = graphState('publish-thread', { desktopChatVisible: true });
    fixture.tool = {
      name: 'files_request_publish',
      metadata: { category: 'files' },
      invoke: vi.fn(async() => {
        await fixture.tool.sendChatMessage?.('', 'tool_approval', { toolApproval: { approvalId: 'decision-7' } });
        return { success: true, result: 'pending' };
      }),
    };
    fixture.toolRegistry.resolveRegisteredName.mockReturnValue('files_request_publish');
    fixture.toolRegistry.getExecutionTarget.mockReturnValue('desktop-local');
    fixture.toolRegistry.createTool.mockImplementation(async() => fixture.tool);

    const result = await executeThroughRegistry(context('publish-thread'), 'files', 'files_request_publish', {
      file_id: 'file-7', version_id: 'version-7',
    }, new AbortController().signal);

    expect(result.success).toBe(true);
    expect(fixture.send).toHaveBeenCalledWith('sulla-desktop', {
      type: 'assistant_message',
      data: expect.objectContaining({ kind: 'tool_approval', thread_id: 'publish-thread', toolApproval: { approvalId: 'decision-7' } }),
    });
  });
});

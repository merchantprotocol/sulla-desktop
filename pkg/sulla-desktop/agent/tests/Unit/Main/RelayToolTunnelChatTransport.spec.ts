// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  send: vi.fn(async(_channel: string, _message: unknown) => true),
  graphState: undefined as any,
  tool: undefined as any,
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
  GraphRegistry: { get: vi.fn((threadId: string) => fixture.graphState?.metadata?.threadId === threadId ? { graph: {}, state: fixture.graphState } : null) },
}));
vi.mock('@pkg/agent/tools', () => ({ toolRegistry: fixture.toolRegistry }));
vi.mock('@pkg/agent/services/AgentContainerRuntimeRegistry', () => ({ containerRuntimeForExecution: () => undefined, withAgentContainerRuntime: (_runtime: unknown, run: () => unknown) => run() }));
vi.mock('@pkg/main/chatCompletionsServer', () => ({ getChatCompletionsServer: () => ({ getApiToken: () => '' }) }));
vi.mock('@pkg/main/deviceIdentity', () => ({ getDesktopDeviceId: vi.fn() }));
vi.mock('@pkg/main/sullaCloudAuth', () => ({ getCurrentUserId: vi.fn() }));
vi.mock('@pkg/runtime/relayTunnelClient', () => ({ RelayToolTunnel: class {} }));
vi.mock('@pkg/utils/logging', () => ({ default: { background: console } }));
vi.mock('@pkg/vault-broker', () => ({ usesContainerVaultAuthority: () => false, configuredVaultBrokerProvider: {} }));
vi.mock('@pkg/utils/instance', () => ({ loopbackOrigin: () => 'http://localhost' }));

import { executeThroughRegistry } from '../../../../main/relayToolTunnel';

describe('relay tool registry chat transport', () => {
  afterEach(() => {
    fixture.graphState = undefined;
    fixture.tool = undefined;
    fixture.toolRegistry.resolveRegisteredName.mockReset();
    fixture.toolRegistry.getExecutionTarget.mockReset();
    fixture.toolRegistry.createTool.mockReset();
    fixture.send.mockClear();
  });

  it('binds files/open to the verified relay thread, ignoring a thread id in caller arguments', async() => {
    // risk: tenant isolation — an agent must never route a file card into a different chat.
    const liveState = { metadata: { threadId: 'verified-thread', wsChannel: 'verified-channel', desktopChatVisible: true } } as any;
    fixture.graphState = liveState;
    fixture.toolRegistry.resolveRegisteredName.mockReturnValue('open');
    fixture.toolRegistry.getExecutionTarget.mockReturnValue('desktop-local');

    const tool = {
      name: 'open',
      metadata: { category: 'files' },
      invoke: vi.fn(async(_args: unknown, state: any) => {
        await tool.sendChatMessage?.('', 'inline_file_reference', { inlineFileReference: { thread_id: state.metadata.threadId } });
        return { success: true, result: 'opened' };
      }),
    } as any;
    fixture.tool = tool;
    fixture.toolRegistry.createTool.mockImplementation(async() => fixture.tool);

    const result = await executeThroughRegistry(
      { v: 1, iss: 'sulla-tools', aud: 'sulla-tools', sub: 'owner', thread_id: 'verified-thread', scopes: [], iat: 1, exp: 2, jti: 'jti', request_id: 'request' } as any,
      'files',
      'open',
      { path: 'Projects/example/file.md', placement: 'inline', thread_id: 'attacker-thread' },
      new AbortController().signal,
    );

    expect(result).toEqual({ success: true, result: 'opened' });
    expect(tool.invoke).toHaveBeenCalledWith(
      { path: 'Projects/example/file.md', placement: 'inline', thread_id: 'attacker-thread' },
      liveState,
    );
    expect(fixture.send).toHaveBeenCalledWith('verified-channel', {
      type: 'assistant_message',
      data: expect.objectContaining({ kind: 'inline_file_reference', thread_id: 'verified-thread' }),
    });
    expect(fixture.send.mock.calls.some(([, message]) => (message as any).data.thread_id === 'attacker-thread')).toBe(false);
  });

  it('does not attach a chat transport when the verified thread has no live graph state', async() => {
    // risk: hidden-thread isolation — no stale or reconstructed caller state may authorize inline delivery.
    fixture.graphState = undefined;
    fixture.toolRegistry.resolveRegisteredName.mockReturnValue('open');
    fixture.toolRegistry.getExecutionTarget.mockReturnValue('desktop-local');
    const tool = {
      name: 'open',
      metadata: { category: 'files' },
      invoke: vi.fn(async() => {
        expect(tool.sendChatMessage).toBeUndefined();
        return { success: true, result: 'tab fallback' };
      }),
    } as any;
    fixture.tool = tool;
    fixture.toolRegistry.createTool.mockImplementation(async() => fixture.tool);

    await executeThroughRegistry(
      { v: 1, iss: 'sulla-tools', aud: 'sulla-tools', sub: 'owner', thread_id: 'expired-thread', scopes: [], iat: 1, exp: 2, jti: 'jti', request_id: 'request' } as any,
      'files', 'open', { path: 'Projects/example/file.md' }, new AbortController().signal,
    );

    expect(fixture.send).not.toHaveBeenCalled();
    expect(tool.invoke).toHaveBeenCalledOnce();
  });

  it('attaches the relay transport to files_request_publish approval cards too', async() => {
    // risk: consent integrity — a publish approval must reach its original visible chat, not disappear on the relay route.
    const liveState = { metadata: { threadId: 'publish-thread', wsChannel: 'publish-channel', desktopChatVisible: true } } as any;
    fixture.graphState = liveState;
    fixture.toolRegistry.resolveRegisteredName.mockReturnValue('files_request_publish');
    fixture.toolRegistry.getExecutionTarget.mockReturnValue('desktop-local');
    const tool = {
      name: 'files_request_publish',
      metadata: { category: 'files' },
      invoke: vi.fn(async() => {
        await tool.sendChatMessage?.('', 'tool_approval', { toolApproval: { approvalId: 'decision-7' } });
        return { success: true, result: 'pending' };
      }),
    } as any;
    fixture.tool = tool;
    fixture.toolRegistry.createTool.mockImplementation(async() => fixture.tool);

    await executeThroughRegistry(
      { v: 1, iss: 'sulla-tools', aud: 'sulla-tools', sub: 'owner', thread_id: 'publish-thread', scopes: [], iat: 1, exp: 2, jti: 'jti', request_id: 'request' } as any,
      'files', 'files_request_publish', { file_id: 'file-7', version_id: 'version-7' }, new AbortController().signal,
    );

    expect(fixture.send).toHaveBeenCalledWith('publish-channel', {
      type: 'assistant_message',
      data: expect.objectContaining({ kind: 'tool_approval', thread_id: 'publish-thread', toolApproval: { approvalId: 'decision-7' } }),
    });
  });
});

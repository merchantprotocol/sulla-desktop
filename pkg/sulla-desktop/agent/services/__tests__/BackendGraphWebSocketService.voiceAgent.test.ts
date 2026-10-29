/** @jest-environment node */
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const statesByThread = new Map<string, any>();
let completionDispatcher: ((channelId: string, threadId: string) => void) | undefined;
const takeAgentCompletionsMock: any = jest.fn(() => []);
const createAgentContainerLifecycleMock: any = jest.fn();

jest.unstable_mockModule('../AgentCompletionInbox', () => ({
  registerCompletionIdleDispatcher: jest.fn((dispatcher: any) => { completionDispatcher = dispatcher }),
  takeAgentCompletions:             takeAgentCompletionsMock,
  formatCompletionBatch:            jest.fn(() => '<sub_agent_completions/>'),
  enqueueAgentCompletion:           jest.fn(() => true),
  setCompletionInboxStopped:        jest.fn(),
}));

jest.unstable_mockModule('../AgentContainerLauncher', () => ({
  createAgentContainerLifecycle: createAgentContainerLifecycleMock,
}));

jest.unstable_mockModule('../WebSocketClientService', () => ({
  getWebSocketClientService: jest.fn(() => ({
    connect:   jest.fn(),
    onMessage: jest.fn(() => jest.fn()),
    send:      jest.fn(),
  })),
}));

jest.unstable_mockModule('../SchedulerService', () => ({
  getSchedulerService: jest.fn(() => ({
    cancelEvent:     jest.fn(),
    scheduleEvent:   jest.fn(),
    rescheduleEvent: jest.fn(),
  })),
}));

jest.unstable_mockModule('../GraphRegistry', () => ({
  GraphRegistry: {
    get:                   jest.fn((threadId: string) => statesByThread.has(threadId) ? { state: statesByThread.get(threadId) } : null),
    getOrCreateAgentGraph: jest.fn(),
    delete:                jest.fn(),
  },
  getAgentIdForTrigger: jest.fn(() => Promise.resolve('sulla-desktop')),
  nextThreadId:         jest.fn(() => 'thread-generated'),
  nextMessageId:        jest.fn(() => 'msg-1'),
}));

jest.unstable_mockModule('../../nodes/ThreadStateStore', () => ({
  loadThreadState: jest.fn(() => Promise.resolve(null)),
  saveThreadState: jest.fn(() => Promise.resolve()),
}));

jest.unstable_mockModule('../ActiveAgentsRegistry', () => ({
  getActiveAgentsRegistry: jest.fn(() => ({
    register:   jest.fn(() => Promise.resolve(undefined)),
    deregister: jest.fn(() => Promise.resolve(undefined)),
  })),
}));

jest.unstable_mockModule('../../utils/sullaPaths', () => ({
  resolveAllAgentsDirs: jest.fn(() => []),
  resolveSullaLogsDir:  jest.fn(() => '/tmp'),
}));

function agentState(agentId: string, model: string): any {
  return { metadata: { agentId, wsChannel: 'mobile-relay', threadId: 'voice-thread', agent: { model }, options: {} }, messages: [] };
}

describe('BackendGraphWebSocketService voice agent threads', () => {
  beforeEach(() => {
    statesByThread.clear();
    completionDispatcher = undefined;
    takeAgentCompletionsMock.mockReset();
    takeAgentCompletionsMock.mockReturnValue([]);
    createAgentContainerLifecycleMock.mockReset();
    createAgentContainerLifecycleMock.mockImplementation((run: any) => Promise.resolve({
      closed:  false,
      agentId: run.state.metadata.agentId,
      close:   jest.fn(() => Promise.resolve({})),
    }));
  });

  it('wakes a worker completion on the agent that owns the thread', async() => {
    const { BackendGraphWebSocketService } = await import('../BackendGraphWebSocketService');
    const svc: any = new BackendGraphWebSocketService();
    const dispatch: any = jest.fn(() => Promise.resolve());
    svc.dispatchToAgent = dispatch;
    const entry = { jobId: 'job-1' };

    statesByThread.set('voice-thread', agentState('conversationalist', 'fast'));
    takeAgentCompletionsMock.mockReturnValueOnce([entry]);
    completionDispatcher!('mobile-relay', 'voice-thread');
    expect(dispatch).toHaveBeenLastCalledWith(
      'mobile-relay', 'sulla-desktop', '<sub_agent_completions/>', 'voice-thread', undefined, 'conversationalist', 'system',
      expect.objectContaining({ source: 'sub_agent_completion', completionJobIds: ['job-1'] }),
    );

    // A thread the registry no longer holds keeps the trigger default.
    takeAgentCompletionsMock.mockReturnValueOnce([entry]);
    completionDispatcher!('mobile-relay', 'unknown-thread');
    expect((dispatch.mock.calls.at(-1) as any[])[5]).toBeUndefined();
    svc.dispose();
  });

  it('never hands a warm conversation container to a different agent', async() => {
    const { BackendGraphWebSocketService } = await import('../BackendGraphWebSocketService');
    const svc: any = new BackendGraphWebSocketService();
    const typed = await svc.conversationContainer('mobile-relay', 'voice-thread', 'claude-code', agentState('sulla-desktop', 'primary'));

    // Even mid-turn (in use), an agent change rebuilds instead of reusing the
    // first agent's capability token, Files actor and runtime binding.
    svc.activeAborts.set('mobile-relay|voice-thread', {});
    const voiceState = agentState('conversationalist', 'fast');
    const voice = await svc.conversationContainer('mobile-relay', 'voice-thread', 'claude-code', voiceState);
    expect(voice).not.toBe(typed);
    expect(voice.agentId).toBe('conversationalist');
    expect(typed.close).toHaveBeenCalledWith('agent-switch', 'BackendGraphWebSocketService.conversationContainer');
    expect(createAgentContainerLifecycleMock).toHaveBeenLastCalledWith(expect.objectContaining({ state: voiceState, model: 'fast' }));

    // The same agent keeps its warm container.
    await expect(svc.conversationContainer('mobile-relay', 'voice-thread', 'claude-code', voiceState)).resolves.toBe(voice);
    expect(createAgentContainerLifecycleMock).toHaveBeenCalledTimes(2);
    svc.activeAborts.clear();
    svc.dispose();
  });

  it('rebuilds an idle container when the bridge would pin a different model', async() => {
    const { BackendGraphWebSocketService } = await import('../BackendGraphWebSocketService');
    const svc: any = new BackendGraphWebSocketService();
    const fast = await svc.conversationContainer('mobile-relay', 'voice-thread', 'claude-code', agentState('conversationalist', 'fast'));
    const primary = await svc.conversationContainer('mobile-relay', 'voice-thread', 'claude-code', agentState('conversationalist', 'primary'));

    expect(primary).not.toBe(fast);
    expect(fast.close).toHaveBeenCalledWith('provider-or-model-switch', 'BackendGraphWebSocketService.conversationContainer');
    // Two slot aliases pin nothing, so switching between them stays warm.
    await expect(svc.conversationContainer('mobile-relay', 'voice-thread', 'claude-code', agentState('conversationalist', 'subconscious')))
      .resolves.toBe(primary);
    svc.dispose();
  });
});

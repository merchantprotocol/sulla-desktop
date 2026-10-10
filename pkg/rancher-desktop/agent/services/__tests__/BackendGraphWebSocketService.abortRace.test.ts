import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { AbortService } from '../AbortService';

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject:  (reason?: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolveFn!: Deferred<T>['resolve'];
  let rejectFn!: Deferred<T>['reject'];
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });

  return { promise, resolve: resolveFn, reject: rejectFn };
}

const sendMock: any = jest.fn();
const executeMock: any = jest.fn();
const routeChatAgentMock: any = jest.fn(() => Promise.resolve(null));
const loadThreadStateMock: any = jest.fn(() => Promise.resolve(null));
const saveThreadStateMock: any = jest.fn(() => Promise.resolve());
const state: any = {
  metadata: { options: {} },
  messages: [],
};
const statesByThread = new Map<string, any>();
let messageSequence = 0;

function stateForThread(threadId: string): any {
  let threadState = statesByThread.get(threadId);
  if (!threadState) {
    threadState = threadId === 'thread-1'
      ? state
      : { metadata: { options: {}, threadId }, messages: [] };
    statesByThread.set(threadId, threadState);
  }
  return threadState;
}

jest.unstable_mockModule('../WebSocketClientService', () => ({
  getWebSocketClientService: jest.fn(() => ({
    connect:   jest.fn(),
    onMessage: jest.fn(() => jest.fn()),
    send:      sendMock,
  })),
}));

jest.unstable_mockModule('../SchedulerService', () => ({
  getSchedulerService: jest.fn(() => ({
    cancelEvent:     jest.fn(),
    scheduleEvent:   jest.fn(),
    rescheduleEvent: jest.fn(),
  })),
}));

const getOrCreateAgentGraphMock: any = jest.fn((agentId: string, threadId: string) => {
  const threadState = stateForThread(threadId);
  threadState.metadata.threadId = threadId;
  threadState.metadata.agentId = agentId;
  return Promise.resolve({ graph: { execute: executeMock }, state: threadState });
});

jest.unstable_mockModule('../GraphRegistry', () => ({
  GraphRegistry: {
    get:                   jest.fn((threadId: string) => statesByThread.has(threadId) ? { state: statesByThread.get(threadId) } : null),
    getOrCreateAgentGraph: getOrCreateAgentGraphMock,
    delete:                jest.fn(),
  },
  getAgentIdForTrigger: jest.fn(() => Promise.resolve('sulla-desktop')),
  nextThreadId:         jest.fn(() => 'thread-generated'),
  nextMessageId:        jest.fn(() => `msg-${ ++messageSequence }`),
}));

jest.unstable_mockModule('../../nodes/ThreadStateStore', () => ({
  loadThreadState: loadThreadStateMock,
  saveThreadState: saveThreadStateMock,
}));

jest.unstable_mockModule('../../reflex/ReflexService', () => ({
  routeChatAgent: routeChatAgentMock,
}));

jest.unstable_mockModule('../ChatAgentRouting', () => ({
  resolveRoutableAgent: jest.fn((agentId: string) => Promise.resolve(
    agentId === 'sulla'
      ? { agentId: 'sulla', graphAgentId: 'sulla-desktop', name: 'Sulla' }
      : { agentId, graphAgentId: agentId, name: agentId === 'analytics-worker' ? 'Analytics Worker' : agentId },
  )),
  applyThreadAgentRoute: jest.fn((routeState: any, agent: any) => {
    routeState.metadata.routedAgentId = agent.graphAgentId;
    routeState.metadata.routedAgentSourceId = agent.agentId;
  }),
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

describe('BackendGraphWebSocketService interruption ownership', () => {
  beforeEach(() => {
    executeMock.mockReset();
    sendMock.mockReset();
    routeChatAgentMock.mockReset();
    routeChatAgentMock.mockResolvedValue(null);
    loadThreadStateMock.mockReset();
    loadThreadStateMock.mockResolvedValue(null);
    saveThreadStateMock.mockClear();
    getOrCreateAgentGraphMock.mockClear();
    statesByThread.clear();
    state.metadata = { options: {} };
    state.messages = [];
    messageSequence = 0;
  });

  it('routes only an implicit first desktop message and keeps that route for later turns', async() => {
    const { BackendGraphWebSocketService } = await import('../BackendGraphWebSocketService');
    const svc: any = new BackendGraphWebSocketService();
    executeMock.mockResolvedValue(undefined);
    routeChatAgentMock.mockResolvedValue({ agentId: 'analytics-worker', confidence: 0.91, decisionId: 'route-1' });

    await svc.dispatchToAgent('sulla-desktop', 'sulla-desktop', 'chart weekly revenue', 'route-thread');
    expect(getOrCreateAgentGraphMock).toHaveBeenLastCalledWith('analytics-worker', 'route-thread');
    expect(routeChatAgentMock).toHaveBeenCalledTimes(1);
    expect(saveThreadStateMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith('sulla-desktop', expect.objectContaining({
      type: 'agent_routed',
      data: expect.objectContaining({ threadId: 'route-thread', agentId: 'analytics-worker', decisionId: 'route-1' }),
    }));

    await svc.dispatchToAgent('sulla-desktop', 'sulla-desktop', 'and compare last month', 'route-thread');
    expect(getOrCreateAgentGraphMock).toHaveBeenLastCalledWith('analytics-worker', 'route-thread');
    expect(routeChatAgentMock).toHaveBeenCalledTimes(1);

    loadThreadStateMock.mockResolvedValueOnce({
      metadata: { routedAgentId: 'analytics-worker' },
      messages: [{ role: 'user', content: 'earlier turn' }],
    });
    await svc.dispatchToAgent('sulla-desktop', 'sulla-desktop', 'continue the report', 'persisted-thread');
    expect(getOrCreateAgentGraphMock).toHaveBeenLastCalledWith('analytics-worker', 'persisted-thread');
    expect(routeChatAgentMock).toHaveBeenCalledTimes(1);

    await svc.dispatchToAgent('sulla-desktop', 'sulla-desktop', 'chart this', 'explicit-thread', undefined, 'mockup-designer');
    expect(getOrCreateAgentGraphMock).toHaveBeenLastCalledWith('mockup-designer', 'explicit-thread');
    expect(routeChatAgentMock).toHaveBeenCalledTimes(1);

    await svc.dispatchToAgent('workbench', 'workbench', 'chart this', 'workbench-thread');
    expect(getOrCreateAgentGraphMock).toHaveBeenLastCalledWith('sulla-desktop', 'workbench-thread');
    expect(routeChatAgentMock).toHaveBeenCalledTimes(1);
  });

  it('does not let an aborted superseded run delete the newer run abort handle', async() => {
    const { BackendGraphWebSocketService } = await import('../BackendGraphWebSocketService');
    const svc: any = new BackendGraphWebSocketService();
    const firstStarted = deferred<AbortService>();
    const firstMayFinish = deferred();
    const secondStarted = deferred<AbortService>();
    let firstAbort: AbortService | undefined;
    let secondAbort: AbortService | undefined;

    executeMock.mockImplementationOnce(async(runState: any) => {
      firstAbort = runState.metadata.options.abort;
      if (!firstAbort) throw new Error('first run did not receive an AbortService');
      firstStarted.resolve(firstAbort);
      await new Promise<void>((resolve) => {
        firstAbort?.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      await firstMayFinish.promise;
      throw new DOMException('Operation aborted', 'AbortError');
    });

    executeMock.mockImplementationOnce(async(runState: any) => {
      secondAbort = runState.metadata.options.abort;
      if (!secondAbort) throw new Error('second run did not receive an AbortService');
      secondStarted.resolve(secondAbort);
      await new Promise<void>((resolve) => {
        secondAbort?.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new DOMException('Operation aborted', 'AbortError');
    });

    const firstRun = svc.dispatchToAgent('sulla-desktop', 'sulla-desktop', 'first', 'thread-1');
    const activeFirstAbort = await firstStarted.promise;
    expect(activeFirstAbort.aborted).toBe(false);

    const secondRun = svc.dispatchToAgent('sulla-desktop', 'sulla-desktop', 'second', 'thread-1');
    const activeSecondAbort = await secondStarted.promise;

    expect(firstAbort?.aborted).toBe(true);
    expect(activeSecondAbort.aborted).toBe(false);
    expect(svc.activeAborts.get('sulla-desktop|thread-1')).toBe(activeSecondAbort);

    firstMayFinish.resolve();
    await firstRun;

    expect(svc.activeAborts.get('sulla-desktop|thread-1')).toBe(activeSecondAbort);

    await svc.handleChannelMessage('sulla-desktop', 'sulla-desktop', {
      type:      'stop_run',
      data:      { threadId: 'thread-1' },
      timestamp: Date.now(),
    });
    await secondRun;

    expect(secondAbort?.aborted).toBe(true);
    expect(svc.activeAborts.has('sulla-desktop|thread-1')).toBe(false);
  });

  it('keeps two simultaneous chat threads independent and ignores unscoped stops', async() => {
    const { BackendGraphWebSocketService } = await import('../BackendGraphWebSocketService');
    const svc: any = new BackendGraphWebSocketService();
    const threadAStarted = deferred<AbortService>();
    const threadBStarted = deferred<AbortService>();
    const threadAMayFinish = deferred();
    const threadBMayFinish = deferred();

    executeMock.mockImplementation(async(runState: any) => {
      const threadId = runState.metadata.threadId as string;
      const abort = runState.metadata.options.abort as AbortService;
      const started = threadId === 'thread-a' ? threadAStarted : threadBStarted;
      const mayFinish = threadId === 'thread-a' ? threadAMayFinish : threadBMayFinish;
      started.resolve(abort);

      await Promise.race([
        mayFinish.promise,
        new Promise<void>((resolve) => abort.signal.addEventListener('abort', () => resolve(), { once: true })),
      ]);
      if (abort.aborted) throw new DOMException('Operation aborted', 'AbortError');
    });

    const runA = svc.dispatchToAgent('sulla-desktop', 'sulla-desktop', 'chat A', 'thread-a');
    const abortA = await threadAStarted.promise;
    const runB = svc.dispatchToAgent('sulla-desktop', 'sulla-desktop', 'chat B', 'thread-b');
    const abortB = await threadBStarted.promise;

    expect(abortA.aborted).toBe(false);
    expect(abortB.aborted).toBe(false);
    expect(svc.activeAborts.get('sulla-desktop|thread-a')).toBe(abortA);
    expect(svc.activeAborts.get('sulla-desktop|thread-b')).toBe(abortB);

    // A malformed/legacy stop must not use the shared channel as ownership.
    await svc.handleChannelMessage('sulla-desktop', 'sulla-desktop', {
      type:      'stop_run',
      data:      { tabId: 'tab-b' },
      timestamp: Date.now(),
    });
    expect(abortA.aborted).toBe(false);
    expect(abortB.aborted).toBe(false);

    await svc.handleChannelMessage('sulla-desktop', 'sulla-desktop', {
      type:      'stop_run',
      data:      { tabId: 'stale-tab', threadId: 'stale-thread' },
      timestamp: Date.now(),
    });
    expect(abortA.aborted).toBe(false);
    expect(abortB.aborted).toBe(false);

    // An explicit stop from chat B terminates only chat B; chat A keeps running.
    await svc.handleChannelMessage('sulla-desktop', 'sulla-desktop', {
      type:      'stop_run',
      data:      { tabId: 'tab-b', threadId: 'thread-b' },
      timestamp: Date.now(),
    });
    await runB;

    expect(abortB.aborted).toBe(true);
    expect(abortA.aborted).toBe(false);
    expect(svc.activeAborts.has('sulla-desktop|thread-b')).toBe(false);
    expect(svc.activeAborts.get('sulla-desktop|thread-a')).toBe(abortA);

    threadAMayFinish.resolve();
    await runA;
    expect(svc.activeAborts.has('sulla-desktop|thread-a')).toBe(false);

    // Keep the unused completion deferred explicit so this test cannot leak.
    threadBMayFinish.resolve();
  });
});

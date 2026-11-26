// SPDX-License-Identifier: GPL-2.0-or-later
import '../../Support/TestHomeEnv';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { agentJobProvider } from '../../../app/Providers/AgentJobServiceProvider';
import { waitForAutomaticAgentExecution } from '../../../services/AgentExecutionReadiness';
import { AgentOrchestratorMessageFormatter } from '../../../services/AgentOrchestratorMessageFormatter';
import { agentJobLifecycle } from '../../../services/AgentJobLifecycleService';
import { BackendGraphWebSocketService } from '../../../services/BackendGraphWebSocketService';
import { ChatHeartbeatDeliveryService } from '../../../services/ChatHeartbeatDeliveryService';
import { GraphRegistry } from '../../../services/GraphRegistry';
import { ParkedAgentRehydrator, parkedAgentRehydrator } from '../../../services/ParkedAgentRehydrator';
import { ThreadGraphCache } from '../../../services/ThreadGraphCache';
import * as registry from '../../../tools/agents/jobRegistry';
import { ReturnResultWorker } from '../../../tools/agents/return_result';
import { toolRegistry } from '../../../tools/registry';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => 'test', isPackaged: false }, safeStorage: {} }));
vi.mock('../../../services/AgentExecutionReadiness', () => ({
  waitForAutomaticAgentExecution: vi.fn(() => Promise.resolve()),
  agentExecutionReadiness:        { active: true, draining: false },
}));

const thread = 'worker';
const state = (): any => ({ messages: [], metadata: { delegatedRunActive: true } });
function fixture() {
  const service = Object.create(BackendGraphWebSocketService.prototype);
  service.orchestratorMessageFormatter = new AgentOrchestratorMessageFormatter();
  service.recoveryAbort = new AbortController();
  service.activeAborts = new Map();
  service.readinessWaits = new Map();
  service.dispatchToAgent = vi.fn().mockResolvedValue('accepted');
  return service;
}
const message = (backend: any, metadata = {}) => backend.handleChannelMessage('desktop', 'sulla-desktop', {
  type: 'user_message', data: { threadId: thread, content: 'follow-up', metadata },
});
afterEach(() => vi.restoreAllMocks());

describe('delegated input admission', () => {
  it('refuses a parked wake when the definition resolver rejects, but admits a verified running-task race', async() => {
    const backend = fixture();
    const live = state();
    const resolve = vi.spyOn(parkedAgentRehydrator, 'resolve').mockRejectedValueOnce(new Error('definition disabled')).mockResolvedValue(null);
    vi.spyOn(agentJobProvider.jobs, 'findByTaskThread').mockResolvedValue({ status: 'running', tasks: [{ threadId: thread, status: 'running' }] } as any);
    await agentJobLifecycle.withRunner(thread, live, async() => {
      await expect(backend.wakeParkedAgent('desktop', thread, 'late')).rejects.toThrow('definition disabled');
      expect(resolve).toHaveBeenCalledOnce();
      expect(live.messages).toEqual([]);
      await expect(backend.wakeParkedAgent('desktop', thread, 'timer')).resolves.toBe(true);
      expect(live.messages).toHaveLength(1);
    });
  });

  const target = { channel: 'desktop', threadId: thread, agentId: 'worker-agent' };
  const peer = { target, envelope: { from: 'peer-agent', kind: 'peer', body: 'update', ids: { messageId: 'peer-1', relayed: true } } };

  it.each([false, true])('does not steer a heartbeat when its parked task resumes before wake admission (final=%s)', async(final) => {
    const backend = fixture();
    const live = state();
    const task = { threadId: thread, status: 'parked', agentId: target.agentId };
    const job = { status: 'running' as const, tasks: [task] };
    vi.spyOn(agentJobProvider.jobs, 'findByTaskThread').mockImplementation(() => {
      task.status = 'running'; // Another wake won after heartbeat delivery observed the parked task.
      return Promise.resolve(job as any);
    });
    const queueJobMessage = vi.fn(() => Promise.resolve({ id: 'auto-off' }));
    const heartbeat = new ChatHeartbeatDeliveryService({
      getJob: () => Promise.resolve(job),
      wakeParkedAgent: backend.wakeParkedAgent.bind(backend),
      queueJobMessage,
      send: vi.fn(),
      now: Date.now,
    });
    await agentJobLifecycle.withRunner(thread, live, async() => {
      const receipt = await heartbeat.deliver(target.channel, thread, 'beat', 5, { jobId: 'job', taskIndex: 0 }, { final });
      expect(task.status).toBe('running');
      expect(receipt).toEqual(final ? { delivered: true, queued: true } : { delivered: false, skipped: true });
      expect(queueJobMessage).toHaveBeenCalledTimes(final ? 1 : 0);
      expect(live.messages).toHaveLength(0);
      expect(backend.dispatchToAgent).not.toHaveBeenCalled();
    });
  });

  it('injects an exact-thread peer claim once, wakes the parked owner, and never dispatches a second runner', async() => {
    const backend = fixture();
    const live = state();
    vi.spyOn(parkedAgentRehydrator, 'resolve').mockResolvedValue(null);
    const abort = new AbortController();
    await agentJobLifecycle.withRunner(thread, live, async() => {
      const wake = agentJobLifecycle.waitForWake(thread, abort.signal);
      try {
        expect(agentJobLifecycle.hasLiveWaiter(thread)).toBe(true);
        await expect(backend.wakeInbox(target, peer.envelope.body, [peer])).resolves.toBe('accepted');
        expect(agentJobLifecycle.hasLiveWaiter(thread)).toBe(false);
        await wake;
        await expect(backend.wakeInbox(target, peer.envelope.body, [peer])).resolves.toBe('accepted');
        expect(live.messages).toEqual([expect.objectContaining({
          content:  peer.envelope.body,
          metadata: expect.objectContaining({ inboxMessageIds: ['peer-1'], relayed: true, steerPending: true }),
        })]);
        expect(live.metadata.relayed).toBe(true);
        expect(backend.dispatchToAgent).not.toHaveBeenCalled();
      } finally { abort.abort() }
    });
  });

  it('waits out the automatic launch pause, then refuses a disabled parked definition', async() => {
    const backend = fixture();
    const live = state();
    let resume!: () => void;
    vi.mocked(waitForAutomaticAgentExecution).mockImplementationOnce(() => new Promise(resolve => { resume = resolve }));
    const resolver = new ParkedAgentRehydrator(
      { findByTaskThread: () => Promise.resolve({ status: 'running', tasks: [{ threadId: thread, status: 'parked', agentId: target.agentId }] } as any) },
      { findBySlug: () => Promise.resolve({ enabled: false }) }, () => Promise.resolve(), () => {},
    );
    const resolve = vi.spyOn(parkedAgentRehydrator, 'resolve').mockImplementation(id => resolver.resolve(id));
    await agentJobLifecycle.withRunner(thread, live, async() => {
      const wake = backend.wakeInbox(target, peer.envelope.body, [peer]);
      const rejected = expect(wake).rejects.toThrow(/disabled/);
      try {
        expect(resolve).not.toHaveBeenCalled();
        expect(live.messages).toEqual([]);
      } finally { resume(); await rejected }
      expect(resolve).toHaveBeenCalledWith(thread);
      expect(live.messages).toEqual([]);
      expect(live.metadata.relayed).toBeUndefined();
      expect(backend.dispatchToAgent).not.toHaveBeenCalled();
    });
  });

  it.each(['readiness', 'eligibility'])('defers an exact-thread peer claim stopped during %s', async(phase) => {
    const backend = fixture();
    const live = state();
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve });
    const started = new Promise<void>(resolve => { entered = resolve });
    const hold = () => { entered(); return held };
    if (phase === 'readiness') vi.mocked(waitForAutomaticAgentExecution).mockImplementationOnce(hold);
    vi.spyOn(agentJobProvider.jobs, 'findByTaskThread').mockImplementation(async() => {
      if (phase === 'eligibility') await hold();
      return undefined;
    });
    await agentJobLifecycle.withRunner(thread, live, async() => {
      const receipt = backend.wakeInbox(target, peer.envelope.body, [peer]);
      try {
        await started;
        await backend.handleChannelMessage(target.channel, 'sulla-desktop', { type: 'stop_run', data: { threadId: thread } });
      } finally { release() }
      await expect(receipt).resolves.toBe('deferred');
      expect(live.messages).toHaveLength(0);
      expect(live.metadata.relayed).toBeUndefined();
      expect(backend.dispatchToAgent).not.toHaveBeenCalled();
      expect(backend.readinessWaits.size).toBe(0);
    });
  });

  it('uses the normal fallback if the owner returns during parked eligibility lookup', async() => {
    const backend = fixture();
    backend.dispatchToAgent.mockResolvedValue('failed');
    const live = state();
    vi.spyOn(parkedAgentRehydrator, 'resolve').mockImplementation(() => {
      agentJobLifecycle.contractReturned(thread, { jobId: 'peer-race', taskIndex: 0, returnedAt: 1 });
      return Promise.resolve(null);
    });
    await agentJobLifecycle.withRunner(thread, live, async() => {
      expect(await backend.wakeInbox(target, peer.envelope.body, [peer])).toBe('failed');
      expect(live.messages).toEqual([]);
      expect(live.metadata.relayed).toBeUndefined();
      expect(backend.dispatchToAgent).toHaveBeenCalledOnce();
    });
  });

  it('keeps the original peer dispatch and receipt when the exact thread has no owner', async() => {
    const backend = fixture();
    backend.dispatchToAgent.mockResolvedValue('failed');
    await expect(backend.wakeInbox(target, peer.envelope.body, [peer])).resolves.toBe('failed');
    expect(backend.dispatchToAgent).toHaveBeenCalledExactlyOnceWith(
      target.channel, 'sulla-desktop', peer.envelope.body, thread, undefined, target.agentId, 'system',
      { source: 'agent_inbox', workerMappingNewHumanTurn: false, inboxMessageIds: ['peer-1'], relayed: true }, [],
    );
  });

  it('does not depend on remote support schemas for ordinary chats', async() => {
    const backend = fixture();
    const convert = vi.spyOn(toolRegistry, 'convertToolToLLM').mockRejectedValue(new Error('support offline'));
    await message(backend);
    expect(convert).not.toHaveBeenCalled();
    expect(backend.dispatchToAgent).toHaveBeenCalledOnce();
  });

  it('uses the current recipient and its stored scope after support schemas resolve', async() => {
    const backend = fixture();
    const old = state();
    old.metadata.supportSessionId = 'old-session';
    const next = state();
    next.metadata.supportSessionId = 'new-session';
    let finish!: () => void;
    const barrier = new Promise<void>(resolve => { finish = resolve });
    vi.spyOn(toolRegistry, 'convertToolToLLM').mockImplementation(async() => { await barrier; return {} as any });
    const release = agentJobLifecycle.registerRunner(thread, old);
    const delivery = message(backend);
    release();
    await agentJobLifecycle.withRunner(thread, next, async() => {
      finish();
      await delivery;
      expect(old.messages).toEqual([]);
      expect(next.messages).toHaveLength(1);
      expect(next.metadata.supportSessionId).toBe('new-session');
      expect(next.metadata.allowedToolNames.length).toBeGreaterThan(0);
      expect(next.metadata.allowedToolNames).not.toContain('support.runtime.exec');
    });
  });

  it.each([true, false])('routes late renderer and peer input normally at return commit (cached=%s)', async(cached) => {
    const backend = fixture();
    const closing = state();
    closing.metadata.threadId = thread;
    const cache = new ThreadGraphCache(() => Promise.resolve(), () => false);
    if (cached) cache.set(thread, { state: closing, graph: {} as any });
    vi.spyOn(GraphRegistry, 'get').mockImplementation(id => cache.get(id) ?? null);
    vi.spyOn(GraphRegistry, 'delete').mockImplementation(id => cache.delete(id));
    const job: any = { jobId: 'returning', status: 'running', visibility: 'hidden', tasks: [{ threadId: thread }] };
    vi.spyOn(registry, 'findTaskByThread').mockResolvedValue({ job, taskIndex: 0 });
    vi.spyOn(agentJobProvider.reviewItems, 'itemsForTask').mockResolvedValue([]);
    vi.spyOn(agentJobProvider.reviewGate, 'refusal').mockResolvedValue(null);
    vi.spyOn(agentJobProvider.service, 'openChildrenForThread').mockResolvedValue(0);
    vi.spyOn(registry, 'recordTaskReturn').mockResolvedValue({ ...job, tasks: [{ threadId: thread, returnedAt: 1 }] });
    backend.dispatchToAgent.mockResolvedValue('deferred');
    const abort = new AbortController();
    try {
      await agentJobLifecycle.withRunner(thread, closing, async() => {
        const waiting = agentJobLifecycle.waitForWake(thread, abort.signal);
        const tool = new ReturnResultWorker();
        tool.setState(cached ? closing : { metadata: { threadId: thread } } as any);
        try {
          expect((await (tool as any)._validatedCall({ summary: 'done' })).successBoolean).toBe(true);
          expect(agentJobLifecycle.hasLiveWaiter(thread)).toBe(false);
          expect(agentJobLifecycle.hasRunner(thread)).toBe(true);
          expect(agentJobLifecycle.liveState(thread)).toBeUndefined();
          expect(cache.has(thread)).toBe(false);
          await message(backend);
          expect(await backend.wakeInbox(target, peer.envelope.body, [peer])).toBe('deferred');
          expect(backend.dispatchToAgent).toHaveBeenCalledTimes(2);
          expect(closing.messages).toEqual([]);
          // The runner may not have reached its next wait at commit time.
          const later = agentJobLifecycle.waitForWake(thread, abort.signal);
          expect(agentJobLifecycle.hasLiveWaiter(thread)).toBe(false);
          await later;
        } finally { abort.abort(); await waiting }
      });
    } finally { cache.clear() }
  });

  it('dispatches renderer input normally during terminal persistence on an evicted thread', async() => {
    const backend = fixture();
    const closing = state();
    vi.spyOn(GraphRegistry, 'get').mockReturnValue(null);
    let persist!: () => void;
    const barrier = new Promise<void>(resolve => { persist = resolve });
    const write = agentJobLifecycle.withRunner(thread, closing, () => {
      agentJobLifecycle.closeInput(thread, closing);
      return barrier;
    });
    try {
      expect(agentJobLifecycle.hasRunner(thread)).toBe(true);
      await message(backend);
      expect(backend.dispatchToAgent).toHaveBeenCalledOnce();
      expect(closing.messages).toEqual([]);
    } finally { persist(); await write }
  });
});

// SPDX-License-Identifier: GPL-2.0-or-later
import '../../Support/TestHomeEnv';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { agentJobLifecycle } from '../../../services/AgentJobLifecycleService';
import { BackendGraphWebSocketService } from '../../../services/BackendGraphWebSocketService';
import { agentJobProvider } from '../../../app/Providers/AgentJobServiceProvider';
import { parkedAgentRehydrator } from '../../../services/ParkedAgentRehydrator';
import { toolRegistry } from '../../../tools/registry';
import { GraphRegistry } from '../../../services/GraphRegistry';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => 'test', isPackaged: false }, safeStorage: {} }));
vi.mock('../../../services/AgentExecutionReadiness', () => ({
  waitForAutomaticAgentExecution: () => Promise.resolve(),
  agentExecutionReadiness:        { active: true, draining: false },
}));

const thread = 'worker';
const state = (): any => ({ messages: [], metadata: { delegatedRunActive: true } });
function fixture() {
  const service = Object.create(BackendGraphWebSocketService.prototype);
  service.recoveryAbort = new AbortController();
  service.activeAborts = new Map();
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

  it('injects an exact-thread peer claim once, wakes the parked owner, and never dispatches a second runner', async() => {
    const backend = fixture();
    const live = state();
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

// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getScheduler: vi.fn(), ensureLifecycle: vi.fn(async() => undefined), getJob: vi.fn(), findTaskByThread: vi.fn(), persistJobHeartbeat: vi.fn(async() => undefined),
}));
vi.mock('@pkg/agent/app/Providers/ChatHeartbeatServiceProvider', () => ({
  chatHeartbeatProvider: {
    scheduler: mocks.getScheduler, ensureJobLifecycleSubscription: mocks.ensureLifecycle,
    persistJobHeartbeat: mocks.persistJobHeartbeat,
  },
}));
vi.mock('@pkg/agent/tools/agents/jobRegistry', () => ({ getJob: mocks.getJob, findTaskByThread: mocks.findTaskByThread }));

import { SetChatHeartbeatWorker } from '@pkg/agent/tools/chat/set_heartbeat';
import { ChatHeartbeatScheduler } from '../../../services/ChatHeartbeatScheduler';

class TestableSetChatHeartbeatWorker extends SetChatHeartbeatWorker {
  set(input: any) { return this._validatedCall(input) }
}

describe('SetChatHeartbeatWorker', () => {
  let scheduler: ChatHeartbeatScheduler;
  const deliver = vi.fn(async() => true);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 10, 24, 20, 0));
    deliver.mockClear();
    mocks.persistJobHeartbeat.mockClear();
    scheduler = new ChatHeartbeatScheduler({ now: () => Date.now(), isGraphBusy: () => false, deliver });
    mocks.getScheduler.mockReturnValue(scheduler);
    mocks.getJob.mockResolvedValue({
      jobId: 'job-1', status: 'parked', parentChannel: 'sulla-desktop',
      tasks: [{ threadId: 'job-thread', agentId: 'codex-sol-worker', status: 'parked' }],
    });
    mocks.findTaskByThread.mockResolvedValue(undefined);
  });

  afterEach(() => { vi.useRealTimers() });

  it('turns off both chat and delegated-task heartbeats when intervalMinutes is zero', async() => {
    // risk: hidden jobs retain a recurring wake after their agent explicitly turned its heartbeat off.
    for (const context of [
      { threadId: 'chat-thread' },
      { threadId: 'job-thread', delegatedJobId: 'job-1' },
    ]) {
      const worker = new TestableSetChatHeartbeatWorker();
      worker.setState({ metadata: { wsChannel: 'sulla-desktop', ...context } } as any);

      const enabled = await worker.set({ intervalMinutes: 5, message: 'Check the work.' });
      expect(enabled.successBoolean).toBe(true);
      expect(enabled.responseString).toContain(scheduler.activationNotice(context.threadId));
      expect(scheduler.status(context.threadId)?.enabled).toBe(true);

      const disabled = await worker.set({ intervalMinutes: 0 });
      expect(disabled).toMatchObject({ successBoolean: true, responseString: 'Heartbeat is off.' });
      expect(scheduler.status(context.threadId)).toMatchObject({ enabled: false, intervalMinutes: null });
    }

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('stays off when set_heartbeat(0) runs during the beat it is waiting to turn off', async() => {
    // risk: a worker turning its heartbeat off during a wake leaves an orphaned timer that wakes it forever.
    let releaseDelivery: (() => void) | undefined;
    const deliveryPending = new Promise<void>(resolve => { releaseDelivery = resolve });
    const heldDeliver = vi.fn(async() => { await deliveryPending; return true });
    scheduler = new ChatHeartbeatScheduler({ now: () => Date.now(), isGraphBusy: () => false, deliver: heldDeliver });
    mocks.getScheduler.mockReturnValue(scheduler);
    const register = vi.spyOn(scheduler, 'register');
    const worker = new TestableSetChatHeartbeatWorker();
    worker.setState({ metadata: { wsChannel: 'sulla-desktop', threadId: 'job-thread', delegatedJobId: 'job-1' } } as any);

    expect((await worker.set({ intervalMinutes: 5, message: 'Keep working.' })).successBoolean).toBe(true);
    expect(register).toHaveBeenCalledTimes(1); // no runtime existed yet
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(heldDeliver).toHaveBeenCalledTimes(1);

    expect(await worker.set({ intervalMinutes: 0 })).toMatchObject({ successBoolean: true, responseString: 'Heartbeat is off.' });
    expect(register).toHaveBeenCalledTimes(1); // the existing job binding is preserved in place
    releaseDelivery!();
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);

    expect(heldDeliver).toHaveBeenCalledTimes(1);
    expect(scheduler.status('job-thread')).toMatchObject({ enabled: false, intervalMinutes: null, nextAt: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('registers only when the runtime is absent or a delegated job binding is missing', async() => {
    // risk: rebinding on every tool call replaces timer state during an in-flight delivery.
    const register = vi.spyOn(scheduler, 'register');
    const worker = new TestableSetChatHeartbeatWorker();
    worker.setState({ metadata: { wsChannel: 'sulla-desktop', threadId: 'job-thread', delegatedJobId: 'job-1' } } as any);

    await worker.set({ intervalMinutes: 5 });
    await worker.set({ intervalMinutes: 10 });
    expect(register).toHaveBeenCalledTimes(1);

    scheduler.register({ threadId: 'unbound-job-thread', channel: 'sulla-desktop', config: { intervalMinutes: null, message: 'Check.' } });
    worker.setState({ metadata: { wsChannel: 'sulla-desktop', threadId: 'unbound-job-thread', delegatedJobId: 'job-1' } } as any);
    mocks.getJob.mockResolvedValueOnce({
      jobId: 'job-1', status: 'parked', parentChannel: 'sulla-desktop',
      tasks: [{ threadId: 'unbound-job-thread', agentId: 'codex-sol-worker', status: 'parked' }],
    });

    await worker.set({ intervalMinutes: 5 });
    expect(register).toHaveBeenCalledTimes(3); // one manual setup plus the one required job bind
    expect(scheduler.jobTarget('unbound-job-thread')).toEqual({ jobId: 'job-1', taskIndex: 0 });
  });

  it('clamps chat intervals to one minute and delegated CLI-context intervals to five', async() => {
    // risk: sub-minute timers can spin a chat; a delegated worker can burn tokens by scheduling too often.
    const chat = new TestableSetChatHeartbeatWorker();
    chat.setState({ metadata: { wsChannel: 'sulla-desktop', threadId: 'chat-minimum' } } as any);
    const chatResult = await chat.set({ intervalMinutes: 0.25 });
    expect(scheduler.status('chat-minimum')?.intervalMinutes).toBe(1);
    expect(chatResult.responseString).toContain('Minimum interval: 1 minute(s) for chats.');

    mocks.getJob.mockImplementation(async(jobId: string) => jobId === 'context-job' ? {
      jobId: 'context-job', status: 'parked', parentChannel: 'sulla-desktop',
      tasks: [
        { threadId: 'other-thread', agentId: 'codex-sol-worker', status: 'parked' },
        { threadId: 'cli-thread', agentId: 'codex-sol-worker', status: 'parked' },
      ],
    } : undefined);
    const cli = new TestableSetChatHeartbeatWorker();
    cli.setState({ metadata: { wsChannel: 'sulla-desktop', threadId: 'cli-thread', delegatedJobId: 'wrong-metadata-job' } } as any);
    cli.executionContext = { job_id: 'context-job', task_index: 1, thread_id: 'cli-thread' } as any;

    const cliResult = await cli.set({ intervalMinutes: 1 });
    expect(mocks.getJob).toHaveBeenCalledWith('context-job');
    expect(mocks.getJob).not.toHaveBeenCalledWith('wrong-metadata-job');
    expect(scheduler.status('cli-thread')?.intervalMinutes).toBe(5);
    expect(cliResult.responseString).toContain('Minimum interval: 5 minute(s) for delegated tasks.');
    expect(cliResult.responseString).toContain('raised to the 5-minute minimum');
    expect(mocks.persistJobHeartbeat).toHaveBeenCalledWith('cli-thread');
    scheduler.unregister('chat-minimum');
    deliver.mockClear();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(deliver.mock.calls[0]?.slice(0, 5)).toEqual([
      'sulla-desktop', 'cli-thread', expect.any(String), 5, { jobId: 'context-job', taskIndex: 1 },
    ]);
  });

  it('treats a parent that launched running, finished and stopped child jobs as its own chat', async() => {
    // risk: a parent's own chat heartbeat is rejected or saved against a child job that does not own its thread.
    const children = new Map([
      ['running-child', { jobId: 'running-child', status: 'running', parentThreadId: 'parent-thread', tasks: [{ threadId: 'running-thread', status: 'running' }] }],
      ['finished-tab-child', { jobId: 'finished-tab-child', status: 'completed', parentThreadId: 'parent-thread', visibility: 'tab', tasks: [{ threadId: 'finished-tab-thread', status: 'completed' }] }],
      ['stopped-child', { jobId: 'stopped-child', status: 'stopped', parentThreadId: 'parent-thread', tasks: [{ threadId: 'stopped-thread', status: 'stopped' }] }],
    ]);
    mocks.getJob.mockImplementation(async(jobId: string) => children.get(jobId));
    const worker = new TestableSetChatHeartbeatWorker();
    worker.setState({ metadata: { wsChannel: 'sulla-desktop', threadId: 'parent-thread', delegatedJobId: 'running-child', jobId: 'finished-tab-child' } } as any);
    worker.executionContext = { job_id: 'stopped-child', thread_id: 'parent-thread' } as any;

    const on = await worker.set({ intervalMinutes: 15 });
    expect(on.successBoolean).toBe(true);
    expect(scheduler.status('parent-thread')?.intervalMinutes).toBe(15);
    expect(scheduler.jobTarget('parent-thread')).toBeUndefined();
    expect(mocks.persistJobHeartbeat).not.toHaveBeenCalled();
    expect(mocks.getJob).toHaveBeenCalledWith('running-child');
    expect(mocks.getJob).toHaveBeenCalledWith('finished-tab-child');
    expect(mocks.getJob).toHaveBeenCalledWith('stopped-child');

    const clamped = await worker.set({ intervalMinutes: 0.25 });
    expect(scheduler.status('parent-thread')?.intervalMinutes).toBe(1);
    expect(clamped.responseString).toContain('Minimum interval: 1 minute(s) for chats.');
    expect((await worker.set({ intervalMinutes: 0 })).responseString).toBe('Heartbeat is off.');
    expect(scheduler.status('parent-thread')).toMatchObject({ enabled: false, intervalMinutes: null });
  });

  it('keeps a tab agent bound to its own task when it has launched child workers', async() => {
    // risk: a tab parent adopts its most recently launched child job and loses the heartbeat that should wake its own task.
    mocks.findTaskByThread.mockResolvedValue({
      job: {
        jobId: 'tab-own-job', status: 'running', parentChannel: 'sulla-desktop',
        tasks: [{ threadId: 'tab-thread', agentId: 'tab-agent', status: 'running' }],
      },
      taskIndex: 0,
    });
    const worker = new TestableSetChatHeartbeatWorker();
    worker.setState({ metadata: { wsChannel: 'sulla-desktop', threadId: 'tab-thread', delegatedJobId: 'child-job' } } as any);

    const result = await worker.set({ intervalMinutes: 1 });

    expect(result.successBoolean).toBe(true);
    expect(scheduler.status('tab-thread')?.intervalMinutes).toBe(5);
    expect(scheduler.jobTarget('tab-thread')).toEqual({ jobId: 'tab-own-job', taskIndex: 0 });
    expect(mocks.persistJobHeartbeat).toHaveBeenCalledWith('tab-thread');
  });

  it('resolves two chats for the same agent by thread ownership, not agent identity', async() => {
    // risk: same-agent conversations cross-bind a plain parent chat to a sibling delegated task.
    mocks.findTaskByThread.mockImplementation(async(threadId: string) => threadId === 'owned-thread' ? ({
      job: {
        jobId: 'owned-job', status: 'parked', parentChannel: 'account-manager',
        tasks: [{ threadId: 'owned-thread', agentId: 'account-manager', status: 'parked' }],
      },
      taskIndex: 0,
    }) : undefined);
    mocks.getJob.mockResolvedValue({
      jobId: 'child-job', status: 'running', parentThreadId: 'parent-thread',
      tasks: [{ threadId: 'leaf-thread', agentId: 'worker', status: 'running' }],
    });
    const owned = new TestableSetChatHeartbeatWorker();
    owned.setState({ metadata: { wsChannel: 'account-manager', threadId: 'owned-thread', delegatedJobId: 'child-job' } } as any);
    const parent = new TestableSetChatHeartbeatWorker();
    parent.setState({ metadata: { wsChannel: 'account-manager', threadId: 'parent-thread', delegatedJobId: 'child-job' } } as any);

    expect((await owned.set({ intervalMinutes: 1 })).successBoolean).toBe(true);
    expect(scheduler.jobTarget('owned-thread')).toEqual({ jobId: 'owned-job', taskIndex: 0 });
    expect((await parent.set({ intervalMinutes: 1 })).successBoolean).toBe(true);
    expect(scheduler.status('parent-thread')?.intervalMinutes).toBe(1);
    expect(scheduler.jobTarget('parent-thread')).toBeUndefined();
  });

  it.each(['completed', 'stopped'] as const)('still refuses the heartbeat for a task whose own job is %s', async(status) => {
    // risk: terminal delegated work is silently revived by a heartbeat after return or stop.
    mocks.getJob.mockResolvedValue({
      jobId: 'terminal-job', status, parentChannel: 'sulla-desktop',
      tasks: [{ threadId: 'terminal-thread', agentId: 'codex-sol-worker', status }],
    });
    const worker = new TestableSetChatHeartbeatWorker();
    worker.setState({ metadata: { wsChannel: 'sulla-desktop', threadId: 'terminal-thread', delegatedJobId: 'terminal-job' } } as any);

    const result = await worker.set({ intervalMinutes: 15 });

    expect(result).toMatchObject({ successBoolean: false, responseString: 'This delegated task is no longer open; its heartbeat cannot be changed.' });
    expect(scheduler.has('terminal-thread')).toBe(false);
  });
});

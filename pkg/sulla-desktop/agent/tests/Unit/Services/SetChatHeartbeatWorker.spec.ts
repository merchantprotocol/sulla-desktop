// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getScheduler: vi.fn(), ensureLifecycle: vi.fn(async() => undefined), getJob: vi.fn(), persistJobHeartbeat: vi.fn(async() => undefined),
}));
vi.mock('@pkg/agent/app/Providers/ChatHeartbeatServiceProvider', () => ({
  chatHeartbeatProvider: {
    scheduler: mocks.getScheduler, ensureJobLifecycleSubscription: mocks.ensureLifecycle,
    persistJobHeartbeat: mocks.persistJobHeartbeat,
  },
}));
vi.mock('@pkg/agent/tools/agents/jobRegistry', () => ({ getJob: mocks.getJob }));

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
  });
});

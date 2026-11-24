// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getService: vi.fn(), ensureLifecycle: vi.fn(async() => undefined), getJob: vi.fn() }));
vi.mock('@pkg/agent/services/ChatHeartbeatService', () => ({
  getChatHeartbeatService: mocks.getService,
  ensureChatHeartbeatJobLifecycle: mocks.ensureLifecycle,
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
    scheduler = new ChatHeartbeatScheduler({ now: () => Date.now(), isGraphBusy: () => false, deliver });
    mocks.getService.mockReturnValue(scheduler);
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
});

// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { ChatHeartbeatDeliveryService } from '../../../services/ChatHeartbeatDeliveryService';

describe('ChatHeartbeatDeliveryService', () => {
  it('cancels the old wait and wakes a parked job with the system heartbeat message', async() => {
    // risk: parked hidden workers never resume for their own heartbeat, or their older wait fires twice.
    const message = 'Progress request.\n\nSystem: heartbeat notice.';
    const cancelWait = vi.fn(async() => true);
    const wakeParkedAgent = vi.fn(async() => true);
    const send = vi.fn(async() => true);
    const service = new ChatHeartbeatDeliveryService({
      getJob: async() => ({
        status: 'parked', parentChannel: 'sulla-desktop',
        tasks: [{ threadId: 'hidden-thread', agentId: 'codex-sol-worker', status: 'parked' }],
      }),
      cancelWait, wakeParkedAgent, send, now: () => 123,
    });

    const result = await service.deliver('other-channel', 'hidden-thread', message, 15, { jobId: 'job-1', taskIndex: 0 });

    expect(result).toEqual({ delivered: true });
    expect(cancelWait).toHaveBeenCalledWith('job-1', 0);
    expect(wakeParkedAgent).toHaveBeenCalledWith('sulla-desktop', 'hidden-thread', message, 'codex-sol-worker', {
      source: 'chat_heartbeat', inputSource: 'system', intervalMinutes: 15,
      delegatedJobId: 'job-1', delegatedTaskIndex: 0,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('stops delivery when its job task has already settled', async() => {
    // risk: a terminal job can be rehydrated by a timer that outlived its owner.
    const wakeParkedAgent = vi.fn(async() => true);
    const service = new ChatHeartbeatDeliveryService({
      getJob: async() => ({
        status: 'completed',
        tasks: [{ threadId: 'hidden-thread', agentId: 'codex-sol-worker', status: 'completed' }],
      }),
      cancelWait: async() => true, wakeParkedAgent, send: async() => true, now: () => 123,
    });

    await expect(service.deliver('sulla-desktop', 'hidden-thread', 'heartbeat', 15, { jobId: 'job-1', taskIndex: 0 }))
      .resolves.toEqual({ delivered: false, terminal: true });
    expect(wakeParkedAgent).not.toHaveBeenCalled();
  });
});

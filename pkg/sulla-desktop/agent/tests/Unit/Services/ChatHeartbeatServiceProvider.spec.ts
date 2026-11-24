// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/main/SleepPreventionService', () => ({ acquireChatActivity: vi.fn(), releaseChatActivity: vi.fn() }));
vi.mock('@pkg/agent/services/GraphRegistry', () => ({ GraphRegistry: { get: vi.fn() } }));
vi.mock('@pkg/agent/services/WebSocketClientService', () => ({ getWebSocketClientService: vi.fn() }));

import { ChatHeartbeatServiceProvider, chatHeartbeatProvider } from '@pkg/agent/app/Providers/ChatHeartbeatServiceProvider';
import { getChatHeartbeatService } from '@pkg/agent/services/ChatHeartbeatService';

describe('ChatHeartbeatServiceProvider', () => {
  // risk: duplicate side effects — two schedulers would each fire heartbeat messages and split thread registrations.
  it('hands every caller, including the deprecated getter, the same scheduler', () => {
    const scheduler = chatHeartbeatProvider.scheduler();
    expect(chatHeartbeatProvider.scheduler()).toBe(scheduler);
    expect(getChatHeartbeatService()).toBe(scheduler);
  });

  it('keeps registrations visible through the deprecated getter', () => {
    const provider = new ChatHeartbeatServiceProvider();
    expect(provider.scheduler()).not.toBe(chatHeartbeatProvider.scheduler());
    expect(getChatHeartbeatService().has('thread-not-registered')).toBe(false);
  });

  it('clears a delegated task heartbeat when its job task settles', () => {
    // risk: a completed/stopped hidden task remains timer-owned after the job lifecycle has ended.
    let onJobChange: ((previous: any, next: any) => void) | undefined;
    const provider = new ChatHeartbeatServiceProvider({
      onJobChange: listener => { onJobChange = listener; return () => undefined },
    });
    const scheduler = provider.scheduler();
    scheduler.register({
      threadId: 'terminal-thread', channel: 'sulla-desktop', jobId: 'terminal-job', taskIndex: 0,
      config: { intervalMinutes: 10, message: 'Keep checking.' },
    });
    expect(scheduler.has('terminal-thread')).toBe(true);

    onJobChange?.({
      jobId: 'terminal-job', status: 'running', tasks: [{ status: 'running' }],
    }, {
      jobId: 'terminal-job', status: 'completed', tasks: [{ status: 'completed', finishedAt: Date.now() }],
    });

    expect(scheduler.has('terminal-thread')).toBe(false);
    scheduler.unregister('terminal-thread');
  });
});

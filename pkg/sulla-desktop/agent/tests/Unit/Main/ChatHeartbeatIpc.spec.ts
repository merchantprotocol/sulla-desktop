// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDefinitionLookup } from '../../../services/AgentHeartbeatPolicy';
import { AgentHeartbeatPolicy } from '../../../services/AgentHeartbeatPolicy';
import { ChatHeartbeatScheduler } from '../../../services/ChatHeartbeatScheduler';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handlers = new Map<string, (event: any, input: any) => unknown>();
const scheduler = new ChatHeartbeatScheduler({
  isGraphBusy: () => false,
  deliver:     async() => true,
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, fn: (event: unknown, input: unknown) => unknown) => { handlers.set(name, fn); },
  },
}));

vi.mock('@pkg/agent/services/ChatHeartbeatService', () => ({
  getChatHeartbeatService: () => scheduler,
}));

const fakeEvent = { sender: { isDestroyed: () => false, send: () => undefined } };

describe('chat-heartbeat IPC — the human control on a chat tab', () => {
  afterEach(() => {
    for (const threadId of ['worker-thread', 'disallowed-thread']) scheduler.unregister(threadId);
  });

  it('registers and configures a worker-definition thread without consulting AgentHeartbeatPolicy', async() => {
    // risk: the human's own heartbeat toggle gets silently gated by agent policy and stops working on worker threads
    const { initChatHeartbeatIpc } = await import('../../../../main/chatHeartbeatIpc');
    initChatHeartbeatIpc();

    const policy = new AgentHeartbeatPolicy({
      findBySlug: async() => ({ id: 'sonnet-worker-id', slug: 'sonnet-worker', config: { heartbeat: { allowed: false, defaultIntervalMinutes: 5, minIntervalMinutes: 1, maxIntervalMinutes: 1440 } } }) as never,
      get: async() => null,
    } satisfies AgentDefinitionLookup);
    await expect(policy.decide('sonnet-worker', 7)).resolves.toMatchObject({ allowed: false });

    const register = handlers.get('chat-heartbeat:register')!;
    const registerResult = await register(fakeEvent, { threadId: 'worker-thread', channel: 'worker-channel', config: { intervalMinutes: 0 } }) as { success: boolean };
    expect(registerResult.success).toBe(true);

    const set = handlers.get('chat-heartbeat:set')!;
    const setResult = await set(fakeEvent, { threadId: 'worker-thread', config: { intervalMinutes: 7 } }) as { success: boolean; status: { enabled: boolean; intervalMinutes: number } };

    expect(setResult.success).toBe(true);
    expect(setResult.status).toMatchObject({ enabled: true, intervalMinutes: 7 });
    expect(scheduler.status('worker-thread')).toMatchObject({ enabled: true, intervalMinutes: 7 });
  });

  it('toggles busy state and unregisters a disallowed agent thread through the human path', async() => {
    // risk: the composer heart control cannot turn a heartbeat off on a thread the tool itself would refuse
    const { initChatHeartbeatIpc } = await import('../../../../main/chatHeartbeatIpc');
    initChatHeartbeatIpc();

    const register = handlers.get('chat-heartbeat:register')!;
    await register(fakeEvent, { threadId: 'disallowed-thread', config: { intervalMinutes: 3 } });

    const busy = handlers.get('chat-heartbeat:busy')!;
    const busyResult = await busy(fakeEvent, { threadId: 'disallowed-thread', busy: true }) as { success: boolean };
    expect(busyResult.success).toBe(true);
    expect(scheduler.status('disallowed-thread')).toMatchObject({ paused: true });

    const unregister = handlers.get('chat-heartbeat:unregister')!;
    await unregister(fakeEvent, 'disallowed-thread');
    expect(scheduler.status('disallowed-thread')).toBeNull();
  });
});

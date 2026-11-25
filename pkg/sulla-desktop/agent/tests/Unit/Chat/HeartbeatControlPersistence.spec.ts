// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }));
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: f }));

import HeartbeatControl from '@pkg/pages/chat/components/composer/HeartbeatControl.vue';
import { ChatController } from '@pkg/pages/chat/controller/ChatController';
import { ChatControllerKey } from '@pkg/pages/chat/controller/useChatController';
import { defaultChatHeartbeatConfig } from '@pkg/shared/chatHeartbeat';

describe('HeartbeatControl persistence', () => {
  afterEach(() => { vi.clearAllMocks() });

  it('persists the confirmed scheduler deadline, and not an enabled heartbeat before IPC confirms it', async() => {
    // risk: a renderer restart between configure and save re-registers an enabled heartbeat with a fresh six-hour deadline.
    let saved: any;
    const controller = new ChatController({
      persister: {
        save: state => { saved = JSON.parse(JSON.stringify(state)) },
        load: () => null,
        list: () => [],
        remove: () => undefined,
      },
    });
    controller.setBackendThreadId('composer-heartbeat-thread');

    let resolveSet!: (value: unknown) => void;
    let signalSet!: () => void;
    const setCalled = new Promise<void>(resolve => { signalSet = resolve });
    const setResult = new Promise(resolve => { resolveSet = resolve });
    const startedAt = Date.now();
    const expiresAt = startedAt + 6 * 60 * 60_000;
    const disabledStatus = {
      ...defaultChatHeartbeatConfig(), threadId: 'composer-heartbeat-thread', enabled: false,
      nextAt: null, pending: false, startedAt: null, expiresAt: null,
    };
    f.invoke.mockImplementation(async(channel: string) => {
      if (channel === 'chat-heartbeat:register') return { success: true, status: disabledStatus };
      if (channel === 'chat-heartbeat:set') {
        signalSet();
        return setResult;
      }
      return { success: true };
    });

    const wrapper = mount(HeartbeatControl, { global: { provide: { [ChatControllerKey as symbol]: controller } } });
    try {
      await flushPromises();
      await wrapper.find('.heartbeat-heart').trigger('click');
      await wrapper.find('button[role="switch"]').trigger('click');
      await setCalled;

      // The tab must not persist a newly enabled, deadline-less config while the real deadline is pending.
      expect(saved.heartbeat.intervalMinutes).toBeNull();
      expect(saved.heartbeat.expiresAt).toBeNull();

      resolveSet({
        success: true,
        status: {
          ...disabledStatus, intervalMinutes: 5, message: 'Keep moving.', setBy: 'human', enabled: true,
          startedAt, expiresAt, nextAt: startedAt + 5 * 60_000, pending: false,
        },
      });
      await flushPromises();

      expect(saved.heartbeat).toMatchObject({ intervalMinutes: 5, startedAt, expiresAt, setBy: 'human' });
      expect(controller.heartbeat.value).toMatchObject({ intervalMinutes: 5, startedAt, expiresAt });
    } finally {
      wrapper.unmount();
      await flushPromises();
    }
  });
});

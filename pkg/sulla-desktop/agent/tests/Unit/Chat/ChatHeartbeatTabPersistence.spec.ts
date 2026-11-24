// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { ChatController } from '@pkg/pages/chat/controller/ChatController';

describe('chat heartbeat tab persistence', () => {
  it('round-trips the original start, expiry and setter through controller state', () => {
    // risk: a tab reload resets heartbeat safety metadata and silently grants another six hours.
    let saved: any;
    const controller = new ChatController({
      persister: {
        save: state => { saved = state },
        load: () => null,
        list: () => [],
        remove: () => undefined,
      },
    });
    const heartbeat = {
      intervalMinutes: 7, message: 'Keep moving.', startedAt: 1_000, expiresAt: 21_601_000, setBy: 'human' as const,
    };

    controller.setHeartbeat(heartbeat);

    expect(saved.heartbeat).toMatchObject(heartbeat);
    const restored = new ChatController({ hydrateFrom: JSON.parse(JSON.stringify(controller.serialize())) });
    expect(restored.heartbeat.value).toMatchObject(heartbeat);
  });
});

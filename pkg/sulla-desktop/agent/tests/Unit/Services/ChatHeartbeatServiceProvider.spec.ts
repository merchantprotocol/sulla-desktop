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
});

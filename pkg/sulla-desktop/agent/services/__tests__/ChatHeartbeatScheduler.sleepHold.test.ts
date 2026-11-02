// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, jest } from '@jest/globals';
import { ChatHeartbeatScheduler } from '../ChatHeartbeatScheduler';

describe('ChatHeartbeatScheduler sleep hold', () => {
  it('holds only while the thread heartbeat is enabled and releases on close', () => {
    const setActive = jest.fn();
    const scheduler = new ChatHeartbeatScheduler({
      isGraphBusy: () => false,
      deliver: async() => true,
      setActive,
    });
    scheduler.register({ threadId: 't1', channel: 'sulla-desktop', config: { intervalMinutes: 5, message: 'continue' } });
    expect(setActive).toHaveBeenLastCalledWith('t1', true);
    scheduler.configure('t1', { intervalMinutes: null, message: 'continue' });
    expect(setActive).toHaveBeenLastCalledWith('t1', false);
    scheduler.unregister('t1');
    expect(setActive).toHaveBeenLastCalledWith('t1', false);
  });
});

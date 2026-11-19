// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { ConversationServersLiveEventBridge } from '../ConversationServersLiveEventBridge';

describe('ConversationServersLiveEventBridge', () => {
  it('publishes only channel-scoped changed invalidations without message content', () => {
    // risk: tenant/data privacy; event transport must stay body-free and only refresh the identified channel
    const publish = vi.fn();
    const bridge = new ConversationServersLiveEventBridge(publish);
    bridge.dispatch({ type: 'changed', topic: 'conversations', id: 'channel-7' });
    bridge.dispatch({ type: 'message', topic: 'conversations', id: 'channel-8' });
    bridge.dispatch({ type: 'changed', topic: 'conversations' });
    bridge.dispatch({ type: 'changed', topic: 'files', id: 'collection-1' });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('channel-7');
  });
});

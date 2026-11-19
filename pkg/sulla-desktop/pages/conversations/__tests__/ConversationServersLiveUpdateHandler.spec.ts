// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { ConversationServersLiveUpdateHandler } from '../ConversationServersLiveUpdateHandler';

describe('ConversationServersLiveUpdateHandler', () => {
  it('refreshes unread badges for an unselected channel without fetching its messages', async () => {
    // risk: read-state accuracy; a live event in another active-server channel must refresh unread badges only
    const refreshMessages = vi.fn(async () => undefined);
    const refreshUnread = vi.fn(async () => undefined);
    const handler = new ConversationServersLiveUpdateHandler({
      selectedChannelId: () => 'channel-selected',
      hasChannel: (channelId) => ['channel-selected', 'channel-other'].includes(channelId),
      refreshMessages,
      refreshUnread,
    });

    await handler.refresh('channel-other');

    expect(refreshMessages).not.toHaveBeenCalled();
    expect(refreshUnread).toHaveBeenCalledOnce();
  });

  it('refreshes selected channel history and ignores unknown or missing channel ids', async () => {
    // risk: live channel isolation; do not fetch arbitrary channel ids outside the active server list
    const refreshMessages = vi.fn(async () => undefined);
    const refreshUnread = vi.fn(async () => undefined);
    const handler = new ConversationServersLiveUpdateHandler({
      selectedChannelId: () => 'channel-selected',
      hasChannel: (channelId) => channelId === 'channel-selected',
      refreshMessages,
      refreshUnread,
    });

    await handler.refresh('channel-selected');
    await handler.refresh('foreign-channel');
    await handler.refresh(undefined);

    expect(refreshMessages).toHaveBeenCalledOnce();
    expect(refreshUnread).not.toHaveBeenCalled();
  });
});

// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { ConversationServersData, type ConversationChannel, type ConversationServer } from './ConversationServersData';

describe('ConversationServersData', () => {
  it('resolves channel notification level from member preference, override, then server default', () => {
    // risk: data accuracy; a channel override must not hide an explicit member choice or ignore inherited policy
    const data = new ConversationServersData();
    const server: ConversationServer = { id: 's1', name: 'Team', visibility: 'organization', ownerUserId: 'owner', notificationDefault: 'mentions' };
    const channel: ConversationChannel = { id: 'c1', serverId: 's1', name: 'general', kind: 'text', private: false, notificationOverride: 'all', notificationLevel: 'all' };
    expect(data.effectiveLevel(server, channel)).toBe('all');
    expect(data.effectiveLevel(server, { ...channel, notificationOverride: undefined })).toBe('mentions');
    expect(data.effectiveLevel(server, channel, 'nothing')).toBe('nothing');
  });

  it('formats badges according to all, mentions, and nothing preferences and inserts a stable mention token', () => {
    // risk: read-state accuracy; notification mode must not expose hidden unread counts or suppress mentions
    const data = new ConversationServersData();
    expect(data.badge('all', 4, 1)).toBe('4');
    expect(data.badge('mentions', 4, 1)).toBe('1 mentions');
    expect(data.badge('nothing', 4, 1)).toBe('');
    expect(data.badge('mentions', 0, 0)).toBe('');
    expect(data.mentionToken('user-1')).toBe('<@user-1>');
  });

});

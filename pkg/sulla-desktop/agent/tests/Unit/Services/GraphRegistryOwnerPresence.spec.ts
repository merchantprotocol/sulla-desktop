// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({}));
import { GraphRegistryOwnerPresence } from '../../../app/Services/GraphRegistryOwnerPresence';

describe('GraphRegistryOwnerPresence', () => {
  it('requires a graph entry whose channel and agent identity both match', () => {
    const entries = new Map<string, { state: { metadata: Record<string, unknown> } }>([
      ['owner-thread', { state: { metadata: { wsChannel: 'owner-channel', agentId: 'owner-agent' } } }],
    ]);
    const presence = new GraphRegistryOwnerPresence({ get: threadId => entries.get(threadId) });
    const owner = { threadId: 'owner-thread', channel: 'owner-channel', agentId: 'owner-agent' };
    expect(presence.matches({ ...owner, channel: 'other-channel' })).toBe(false);
    expect(presence.matches({ ...owner, agentId: 'other-agent' })).toBe(false);
    expect(presence.matches(owner)).toBe(true);
  });
});

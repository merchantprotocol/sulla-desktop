// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ findBySlug: vi.fn() }));

vi.mock('@pkg/agent/services/AgentDefinitionService', () => ({
  agentDefinitionService: { findBySlug: f.findBySlug },
}));
vi.mock('@pkg/agent/nodes/TurnProviderResolver', () => ({
  turnProviderResolver: { resolve: vi.fn(async() => ({ provider: 'test' })) },
}));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));

import { runSubconsciousMiddleware } from '@pkg/agent/middleware/SubconsciousMiddleware';

describe('SubconsciousMiddleware awareness refresh', () => {
  it('re-reads an agent definition on each turn instead of trusting stale thread metadata', async() => {
    // risk: a changed privacy setting must take effect on the next turn in the same conversation.
    f.findBySlug.mockReset()
      .mockResolvedValueOnce({ agent_awareness: false })
      .mockResolvedValueOnce({ agent_awareness: true });
    const state = {
      messages: [],
      metadata: { agentId: 'conversationalist', inputSource: 'voice', threadId: 'awareness-refresh-thread' },
    } as any;

    await runSubconsciousMiddleware(state, { includeObservations: false });
    expect(state.metadata.agentAwareness).toBe(false);
    await runSubconsciousMiddleware(state, { includeObservations: false });

    expect(f.findBySlug).toHaveBeenNthCalledWith(1, 'conversationalist');
    expect(f.findBySlug).toHaveBeenNthCalledWith(2, 'conversationalist');
    expect(state.metadata.agentAwareness).toBe(true);
  });
});

// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));
vi.mock('../../../services/WebSocketClientService', () => ({ getWebSocketClientService: () => ({ send: vi.fn() }) }));
import { AgentConversationRegistry } from '../../../app/Services/AgentConversationRegistry';
import { createConversation, getConversation, deleteConversation } from '../../../tools/agents/agentConversations';

const HOUR = 60 * 60 * 1000;

describe('AgentConversationRegistry', () => {
  it('creates unique conversation and thread ids from the clock and a counter', () => {
    // risk: two conversations share a thread and cross-talk
    const registry = new AgentConversationRegistry(() => 1000);
    const a = registry.create('worker', 'Build Thing');
    const b = registry.create('worker', 'Build Thing');
    expect(a.conversationId).toBe('conv-1000-1');
    expect(b.conversationId).toBe('conv-1000-2');
    expect(a.threadId).not.toBe(b.threadId);
    expect(a.threadId).toMatch(/^conv-agent-.+-1000-1$/);
    expect(a).toMatchObject({ channel: 'worker', label: 'Build Thing', status: 'idle', transcript: [], createdAt: 1000, lastActive: 1000 });
    expect(registry.get(a.conversationId)).toBe(a);
  });

  it('records transcript turns and status changes, and ignores unknown ids', () => {
    // risk: replies attach to the wrong conversation or crash on a closed one
    let now = 1000;
    const registry = new AgentConversationRegistry(() => now);
    const conv = registry.create('worker', 'x');
    now = 2000;
    registry.appendTranscript(conv.conversationId, 'parent', 'hi');
    registry.setStatus(conv.conversationId, 'busy');
    expect(conv.transcript).toEqual([{ from: 'parent', text: 'hi', ts: 2000 }]);
    expect(conv.status).toBe('busy');
    expect(conv.lastActive).toBe(2000);
    expect(() => registry.appendTranscript('missing', 'agent', 'x')).not.toThrow();
    expect(() => registry.setStatus('missing', 'idle')).not.toThrow();
  });

  it('prunes idle conversations past the TTL but never a busy one', () => {
    // risk: an in-flight conversation is dropped mid-turn
    let now = 0;
    const registry = new AgentConversationRegistry(() => now);
    const idle = registry.create('w', 'idle');
    const busy = registry.create('w', 'busy');
    registry.setStatus(busy.conversationId, 'busy');
    now = HOUR + 1;
    expect(registry.all().map((c) => c.conversationId)).toEqual([busy.conversationId]);
    expect(registry.get(idle.conversationId)).toBeUndefined();
  });

  it('reports the soft cap at 20 live conversations and frees it on delete', () => {
    // risk: runaway spawning past the cap
    const registry = new AgentConversationRegistry(() => 0);
    const ids = Array.from({ length: 20 }, (_, i) => registry.create('w', `c${ i }`).conversationId);
    expect(registry.atCap()).toBe(true);
    registry.delete(ids[0]);
    expect(registry.atCap()).toBe(false);
  });

  it('keeps the deprecated function facade backed by one shared registry', () => {
    // risk: read/close tools stop finding conversations opened via the old API
    const conv = createConversation('w', 'legacy');
    expect(getConversation(conv.conversationId)).toBe(conv);
    deleteConversation(conv.conversationId);
    expect(getConversation(conv.conversationId)).toBeUndefined();
  });
});

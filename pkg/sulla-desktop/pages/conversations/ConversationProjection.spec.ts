// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { ConversationProjection, type ConversationMessageData } from './ConversationProjection';

const message = (input: Partial<ConversationMessageData> & Pick<ConversationMessageData, 'messageId' | 'conversationId' | 'orgId' | 'from' | 'to'>): ConversationMessageData => ({
  ...input, kind: input.kind ?? 'human', body: input.body ?? { text: input.messageId }, createdAt: input.createdAt ?? '2026-11-18T00:00:00.000Z',
});

describe('ConversationProjection', () => {
  it('groups only active-org messages addressed to or sent by this member', () => {
    // risk: cross-org data leakage or showing messages outside the signed-in member's conversations
    const projection = new ConversationProjection();
    const result = projection.project([
      message({ messageId: 'visible', conversationId: 'thread-a', orgId: 'org-a', from: { userId: 'member-a' }, to: [{ userId: 'member-b' }] }),
      message({ messageId: 'wrong-org', conversationId: 'thread-b', orgId: 'org-b', from: { userId: 'member-a' }, to: [{ userId: 'member-a' }] }),
      message({ messageId: 'not-participant', conversationId: 'thread-c', orgId: 'org-a', from: { userId: 'member-c' }, to: [{ userId: 'member-d' }] }),
    ], [{ userId: 'member-b', displayName: 'Alex Rivera' }], 'org-a', 'member-a');

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('thread-a');
    expect(result[0].title).toBe('Alex Rivera');
  });

  it('orders messages by authoritative host sequence and identifies agent threads', () => {
    // risk: data accuracy; clients must display host order and preserve agent-thread identity
    const projection = new ConversationProjection();
    const result = projection.project([
      message({ messageId: 'later', conversationId: 'thread', orgId: 'org-a', from: { userId: 'member-b', agentId: 'sulla' }, to: [{ userId: 'member-a' }], hostSeq: 2 }),
      message({ messageId: 'earlier', conversationId: 'thread', orgId: 'org-a', from: { userId: 'member-a' }, to: [{ userId: 'member-b' }], hostSeq: 1 }),
    ], [], 'org-a', 'member-a');

    expect(result[0].kind).toBe('agent_thread');
    expect(result[0].messages.map(row => row.messageId)).toEqual(['earlier', 'later']);
    expect(result[0].latest).toBe('later');
  });
});

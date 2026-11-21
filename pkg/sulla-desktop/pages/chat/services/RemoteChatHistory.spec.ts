// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { RemoteChatHistory } from './RemoteChatHistory';
import { asMessageId } from '../types/chat';
import type { Message } from '../models/Message';

const binding = { accountId: 'account', workspaceId: 'workspace', threadId: 'remote_example_123456', deviceId: 'mac', name: 'Mac', cursor: 'saved' };

describe('RemoteChatHistory', () => {
  // risk: data accuracy — missing rows, duplicate IDs and a prematurely advanced cursor.
  it('applies revisions in canonical transcript order and reconciles cache IDs in 96-ID batches', async() => {
    const cached: Message[] = Array.from({ length: 193 }, (_, index) => ({
      id: asMessageId(`cached-${index}`), kind: 'user', createdAt: 1000 + index, text: 'cached',
    }));
    const calls: Array<{ cursor: string; ids: string[]; only: boolean }> = [];
    const first = { id: 'late-arrival', role: 'assistant', content: 'canonical', created_at: new Date(500).toISOString() };
    const changed = { ...first, id: 'cached-0', role: 'user', content: 'updated', created_at: new Date(1000).toISOString() };
    const history = new RemoteChatHistory(async(_thread, cursor, ids, only) => {
      calls.push({ cursor, ids, only });
      if (only) return { status: 200, page: { messages: [], nextCursor: cursor, hasMore: false,
        removedMessageIds: ids.includes('cached-192') ? ['cached-192'] : [] } };
      if (cursor === 'saved') return { status: 200, page: { messages: [changed], nextCursor: 'middle', hasMore: true } };
      return { status: 200, page: { messages: [first, changed], nextCursor: 'end', hasMore: false } };
    });
    const result = await history.catchUp(binding, cached, () => true);
    expect(calls.map(({ cursor, ids, only }) => [cursor, ids.length, only])).toEqual([
      ['saved', 0, false], ['middle', 0, false], ['end', 96, true], ['end', 96, true], ['end', 1, true],
    ]);
    expect(result?.removed).toEqual(['cached-192']);
    expect(result?.cursor).toBe('end');
    expect(result?.messages[0]).toMatchObject({ id: 'late-arrival', text: 'canonical' });
    expect(result?.messages.filter(message => message.id === 'cached-0')).toEqual([
      expect.objectContaining({ text: 'updated' }),
    ]);
    expect(result?.messages.some(message => message.id === 'cached-192')).toBe(false);
  });

  // risk: privacy and data loss — a revoked, stale or failed response is not an empty successful page.
  it('does not publish a failed batch or a stale response from a previous thread', async() => {
    const cached: Message[] = [{ id: asMessageId('one'), kind: 'user', createdAt: 1000, text: 'cached' }];
    const history = new RemoteChatHistory(async(_thread, _cursor, _ids, only) => only
      ? { status: 404 }
      : { status: 200, page: { messages: [], nextCursor: 'fresh', hasMore: false } });
    expect(await history.catchUp(binding, cached, () => true)).toBeUndefined();
    expect(await history.catchUp(binding, cached, () => false)).toBeUndefined();
    expect(cached).toHaveLength(1);
  });
});

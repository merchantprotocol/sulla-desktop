// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BaseThreadState } from '../../nodes/Graph';

const boundary = vi.hoisted(() => {
  const redisValues = new Map<string, string>();
  const redis = {
    status: 'ready',
    ping: vi.fn(async() => 'PONG'),
    setex: vi.fn(async(key: string, _ttl: number, value: string) => {
      redisValues.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async(key: string) => redisValues.get(key) ?? null),
    del: vi.fn(async(key: string) => redisValues.delete(key) ? 1 : 0),
  };

  return { getByThread: vi.fn(), redis, redisValues };
});

vi.mock('../../database/RedisClient', () => ({
  redisClient: { getClient: () => boundary.redis },
}));

vi.mock('../../database/models/ConversationHistoryModel', () => ({
  ConversationHistoryModel: { getByThread: boundary.getByThread },
}));

const makeState = (threadId: string, content = 'hello'): BaseThreadState => ({
  messages: [{ role: 'user', content, metadata: {} }],
  metadata: { threadId },
} as BaseThreadState);

describe('ThreadStateStore characterization', () => {
  beforeEach(() => {
    boundary.redis.status = 'ready';
    boundary.redisValues.clear();
    vi.clearAllMocks();
    boundary.getByThread.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('saves a deep copy, loads it, and deletes both durable and fallback state', async() => {
    // risk: thread data integrity
    const store = await import('../../nodes/ThreadStateStore');
    const state = makeState('thread-crud');

    await store.saveThreadState(state);
    state.messages[0].content = 'mutated after save';

    expect((await store.loadThreadState('thread-crud'))?.messages[0].content).toBe('hello');
    await store.deleteThreadState('thread-crud');
    expect(await store.loadThreadState('thread-crud')).toBeNull();
  });

  it('keeps independent thread values isolated while Redis is unavailable', async() => {
    // risk: cross-thread data leakage
    boundary.redis.status = 'end';
    const store = await import('../../nodes/ThreadStateStore');

    await store.saveThreadState(makeState('thread-a', 'alpha'));
    await store.saveThreadState(makeState('thread-b', 'beta'));

    expect((await store.loadThreadState('thread-a'))?.messages[0].content).toBe('alpha');
    expect((await store.loadThreadState('thread-b'))?.messages[0].content).toBe('beta');
    await store.deleteThreadState('thread-a');
    await store.deleteThreadState('thread-b');
  });

  it('falls back after a Redis write failure and recovers that value while Redis remains down', async() => {
    // risk: thread data loss during infrastructure failure
    const store = await import('../../nodes/ThreadStateStore');
    boundary.redis.setex.mockRejectedValueOnce(new Error('redis down'));

    await store.saveThreadState(makeState('thread-fallback', 'preserved'));
    boundary.redis.status = 'end';

    expect((await store.loadThreadState('thread-fallback'))?.messages[0].content).toBe('preserved');
    await store.deleteThreadState('thread-fallback');
  });

  it('reconstructs messages from the JSONL recovery log when caches miss', async() => {
    // risk: conversation recovery
    boundary.redis.status = 'end';
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-state-'));
    const logFile = path.join(directory, 'thread.jsonl');
    fs.writeFileSync(logFile, [
      JSON.stringify({ type: 'message', role: 'user', content: 'restored', ts: '2026-11-04T00:00:00Z' }),
      '{malformed',
      JSON.stringify({ type: 'tool', content: 'ignored' }),
    ].join('\n'));
    boundary.getByThread.mockResolvedValue({
      id: 'conversation-1', channel_id: 'channel-1', log_file: logFile, last_summary: null, summary: 'summary',
    });

    const store = await import('../../nodes/ThreadStateStore');
    const restored = await store.loadThreadState('thread-log');

    expect(restored?.messages.map(message => message.content)).toEqual(['restored']);
    expect(restored?.metadata.threadId).toBe('thread-log');
    fs.rmSync(directory, { recursive: true, force: true });
  });
});

// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import {
  FallbackThreadStateRepository,
  MemoryThreadStateRepository,
  RedisThreadStateRepository,
  type ThreadStateRepository,
} from '../../../app/Repositories/ThreadStateRepository';
import type { BaseThreadState } from '../../../nodes/Graph';

const state = (threadId: string, content: string): BaseThreadState => ({
  messages: [{ role: 'user', content, metadata: {} }], metadata: { threadId },
} as BaseThreadState);

const redisClient = () => {
  const values = new Map<string, string>();
  return {
    status: 'ready', ping: vi.fn(async() => 'PONG'),
    setex: vi.fn(async(key: string, _ttl: number, value: string) => { values.set(key, value); return 'OK'; }),
    get: vi.fn(async(key: string) => values.get(key) ?? null),
    del: vi.fn(async(key: string) => values.delete(key) ? 1 : 0),
  };
};

describe('ThreadStateRepository strategies', () => {
  it('keeps memory repository instances isolated and returns deep copies', async() => {
    // risk: cross-agent thread leakage
    const first = new MemoryThreadStateRepository();
    const second = new MemoryThreadStateRepository();
    const saved = state('same-id', 'first');
    await first.save(saved);
    saved.messages[0].content = 'caller mutation';

    expect((await first.load('same-id'))?.messages[0].content).toBe('first');
    expect(await second.load('same-id')).toBeNull();
  });

  it('resolves the current Redis client after a reconnect replaces it', async() => {
    // risk: conversation loss after Redis reconnect
    const first = redisClient();
    const second = redisClient();
    let current = first;
    const source = { getClient: () => current };
    const repository = new RedisThreadStateRepository(source);

    expect(await repository.available()).toBe(true);
    current = second;
    expect(await repository.available()).toBe(true);

    expect(first.ping).toHaveBeenCalledTimes(1);
    expect(second.ping).toHaveBeenCalledTimes(1);
  });

  it('preserves Redis serialization, TTL, and delete behavior', async() => {
    // risk: thread data integrity
    const client = redisClient();
    const repository = new RedisThreadStateRepository({ getClient: () => client }, 42);
    await repository.save(state('redis-id', 'durable'));

    expect(client.setex).toHaveBeenCalledWith('sulla:threadstate:redis-id', 42, expect.any(String));
    expect((await repository.load('redis-id'))?.messages[0].content).toBe('durable');
    await repository.delete('redis-id');
    expect(await repository.load('redis-id')).toBeNull();
  });

  it('falls back to memory on Redis failure and uses recovery only after both caches miss', async() => {
    // risk: conversation loss during Redis outage
    const client = redisClient();
    client.setex.mockRejectedValueOnce(new Error('offline'));
    const redis = new RedisThreadStateRepository({ getClient: () => client });
    const memory = new MemoryThreadStateRepository();
    const recovery: ThreadStateRepository = {
      save: vi.fn(async() => undefined), delete: vi.fn(async() => undefined),
      load: vi.fn(async(threadId: string) => state(threadId, 'from-log')),
    };
    const repository = new FallbackThreadStateRepository(redis, memory, recovery, {
      log: vi.fn(), error: vi.fn(),
    });

    await repository.save(state('fallback-id', 'from-memory'));
    client.status = 'end';
    expect((await repository.load('fallback-id'))?.messages[0].content).toBe('from-memory');
    expect(recovery.load).not.toHaveBeenCalled();
    await repository.delete('fallback-id');
    expect((await repository.load('fallback-id'))?.messages[0].content).toBe('from-log');
  });
});

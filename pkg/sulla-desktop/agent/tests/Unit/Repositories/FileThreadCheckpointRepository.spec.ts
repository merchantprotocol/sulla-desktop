// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FallbackThreadStateRepository,
  FileThreadCheckpointRepository,
  LogRecoveryThreadStateRepository,
  MemoryThreadStateRepository,
  RedisThreadStateRepository,
} from '../../../app/Repositories/ThreadStateRepository';

import type { ConversationHistoryRecord } from '../../../database/models/ConversationHistoryModel';
import type { BaseThreadState } from '../../../nodes/Graph';

const MIB = 1024 * 1024;

const state = (threadId: string, content: string): BaseThreadState => ({
  messages: [{ role: 'user', content, metadata: {} }], metadata: { threadId },
} as BaseThreadState);

// Redis is the external edge: an in-memory stand-in that keeps values across "restarts".
const redisClient = (values = new Map<string, string>()) => ({
  values,
  status: 'ready',
  ping:   vi.fn(() => Promise.resolve('PONG')),
  setex:  vi.fn((key: string, _ttl: number, value: string) => {
    values.set(key, value);

    return Promise.resolve('OK');
  }),
  get: vi.fn((key: string) => Promise.resolve(values.get(key) ?? null)),
  del: vi.fn((key: string) => Promise.resolve(values.delete(key) ? 1 : 0)),
});

describe('large thread checkpoints', () => {
  let directory: string;

  beforeEach(async() => {
    directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'thread-checkpoints-'));
  });
  afterEach(async() => {
    await fs.promises.rm(directory, { recursive: true, force: true });
  });

  const logger = { log: vi.fn(), error: vi.fn() };
  const files = () => new FileThreadCheckpointRepository(() => directory);
  const boot = (client: ReturnType<typeof redisClient>, recovery = new MemoryThreadStateRepository()) =>
    new FallbackThreadStateRepository(
      new RedisThreadStateRepository({ getClient: () => client }, 3600, files()),
      new MemoryThreadStateRepository(), recovery, logger,
    );
  const big = 'x'.repeat(MIB);

  it('publishes a small expiring Redis pointer, not a large command argument', async() => {
    const client = redisClient();
    await boot(client).save(state('big-thread', big));
    const [[key, ttl, value]] = client.setex.mock.calls;
    expect(key).toBe('sulla:threadstate:big-thread');
    expect(ttl).toBe(3600);
    expect(Buffer.byteLength(value)).toBeLessThan(128);
    const pointer = JSON.parse(value);
    expect(pointer).toEqual({ sullaCheckpointFile: 1, id: expect.any(String) });
    const [folder] = await fs.promises.readdir(directory);
    expect(folder).toMatch(/^[a-f0-9]{64}$/);
    const names = await fs.promises.readdir(path.join(directory, folder));
    expect(names).toEqual([pointer.id + '.json']);
    if (process.platform !== 'win32') {
      expect((await fs.promises.stat(path.join(directory, folder, names[0]))).mode & 0o777).toBe(0o600);
    }
    expect((await boot(client).load('big-thread'))?.messages[0].content === big).toBe(true);
  });

  it.each(['sullaCheckpointFile', 'sullaCheckpointMemory'])('round-trips inline state containing %s', async(tag) => {
    const client = redisClient();
    const saved = { ...state('inline', 'conversation'), [tag]: 1, id: 'a6cf68e1-846f-40ad-a212-6396d74b167c' };

    await boot(client).save(saved);
    expect(await boot(client).load('inline')).toEqual(saved);
  });

  it('replaces old payloads only after successful publication and shrinks back to inline Redis', async() => {
    const client = redisClient();
    const repo = boot(client);
    await repo.save(state('growing', big));
    const [hash] = await fs.promises.readdir(directory);
    const folder = path.join(directory, hash);
    const [old] = await fs.promises.readdir(folder);
    client.setex.mockRejectedValueOnce(new Error('unavailable'));
    await repo.save(state('growing', 'unpublished' + big));
    expect(fs.existsSync(path.join(folder, old))).toBe(true);
    expect((await boot(client).load('growing'))?.messages[0].content === big).toBe(true);
    await repo.save(state('growing', big + 'again'));
    expect(await fs.promises.readdir(folder)).toHaveLength(1);
    expect(fs.existsSync(path.join(folder, old))).toBe(false);
    await repo.save(state('growing', 'small'));
    expect(await fs.promises.readdir(folder)).toEqual([]);
    expect(JSON.parse(client.values.get('sulla:threadstate:growing')!)).toEqual(state('growing', 'small'));
    expect((await boot(client).load('growing'))?.messages[0].content).toBe('small');
  });

  it('queues saves and deletes; a failed DEL cannot leave a live pointer dangling', async() => {
    const client = redisClient();
    const repo = boot(client);
    await repo.save(state('raced', big));
    client.del.mockRejectedValueOnce(new Error('disconnected'));
    await repo.delete('raced');
    expect((await boot(client).load('raced'))?.messages[0].content === big).toBe(true);
    await Promise.all([repo.delete('raced'), repo.save(state('raced', 'after-delete'))]);
    expect((await boot(client).load('raced'))?.messages[0].content).toBe('after-delete');
    await repo.delete('raced');
    expect(await boot(client).load('raced')).toBeNull();
  });

  it('keeps oversized writes in RAM during disk or Redis outages without logging the state', async() => {
    const client = redisClient();
    const file = path.join(directory, 'not-a-directory');
    await fs.promises.writeFile(file, '');
    const repo = new FallbackThreadStateRepository(
      new RedisThreadStateRepository({ getClient: () => client }, 3600, new FileThreadCheckpointRepository(() => file), logger),
      new MemoryThreadStateRepository(), new MemoryThreadStateRepository(), logger,
    );
    await repo.save(state('small', 'inline'));
    const content = 'private-marker' + big;
    await repo.save(state('large', content));
    expect((await repo.load('large'))?.messages[0].content === content).toBe(true);
    expect(Buffer.byteLength(client.setex.mock.calls[1][2])).toBeLessThan(128);
    client.status = 'end';
    await repo.save(state('offline', content));
    expect(await repo.load('large')).toBeNull();
    expect((await repo.load('offline'))?.messages[0].content === content).toBe(true);
    expect(client.setex).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private-marker');
  });

  it('evicts RAM copies of idle threads once their Redis pointer has expired', async() => {
    const client = redisClient();
    const file = path.join(directory, 'not-a-directory');
    await fs.promises.writeFile(file, '');
    let clock = 0;
    const redis = new RedisThreadStateRepository(
      { getClient: () => client }, 3600, new FileThreadCheckpointRepository(() => file), logger, () => clock,
    );
    const repo = new FallbackThreadStateRepository(redis, new MemoryThreadStateRepository(), new MemoryThreadStateRepository(), logger);
    await repo.save(state('idle-a', 'a' + big));
    await repo.save(state('idle-b', 'b' + big));
    clock = 3599 * 1000;
    expect((await repo.load('idle-a'))?.messages[0].content === 'a' + big).toBe(true);
    expect(redis['memoryHeads'].size).toBe(2);
    // Both threads go idle past the TTL: Redis drops the pointers, and an unrelated thread's save evicts the copies.
    clock = 3600 * 1000;
    client.values.clear();
    await repo.save(state('active', 'inline'));
    expect(redis['memoryHeads'].size).toBe(0);
    await repo.save(state('idle-c', 'c' + big));
    clock = 7200 * 1000;
    client.values.clear();
    expect(await repo.load('active')).toBeNull();
    expect(redis['memoryHeads'].size).toBe(0);
  });

  it('returns the RAM copy a live pointer named even if another thread evicts it during the read', async() => {
    const client = redisClient();
    const file = path.join(directory, 'not-a-directory');
    await fs.promises.writeFile(file, '');
    let clock = 0;
    const redis = new RedisThreadStateRepository(
      { getClient: () => client }, 3600, new FileThreadCheckpointRepository(() => file), logger, () => clock,
    );
    await redis.save(state('reader', 'r' + big));
    let reply!: () => void;
    client.get.mockImplementationOnce((key: string) => {
      const pointer = client.values.get(key) ?? null;
      return new Promise(resolve => { reply = () => resolve(pointer) });
    });
    const reading = redis.load('reader');
    await new Promise(resolve => setImmediate(resolve));
    // Redis expires the pointer and another thread's save sweeps the copy before the GET reply is read.
    clock = 3600 * 1000;
    client.values.clear();
    await redis.save(state('other', 'inline'));
    expect(redis['memoryHeads'].has('reader')).toBe(false);
    reply();
    expect((await reading)?.messages[0].content === 'r' + big).toBe(true);
  });

  it('keeps a RAM copy past its local deadline while Redis still holds its pointer', async() => {
    const client = redisClient();
    const file = path.join(directory, 'not-a-directory');
    await fs.promises.writeFile(file, '');
    let clock = 0;
    const redis = new RedisThreadStateRepository(
      { getClient: () => client }, 3600, new FileThreadCheckpointRepository(() => file), logger, () => clock,
    );
    await redis.save(state('stepped', 's' + big));
    // Redis's wall clock stepped back, so its pointer outlives the local monotonic deadline.
    clock = 3601 * 1000;
    await redis.save(state('other', 'inline'));
    expect((await redis.load('stepped'))?.messages[0].content === 's' + big).toBe(true);
    // Once Redis drops the pointer, the next check evicts the copy.
    client.values.delete('sulla:threadstate:stepped');
    clock = 7200 * 1000;
    await redis.save(state('other', 'inline'));
    expect(redis['memoryHeads'].size).toBe(0);
  });

  it('saves and loads an inline thread while an unrelated checkpoint probe never settles', async() => {
    const client = redisClient();
    let clock = 0;
    const redis = new RedisThreadStateRepository({ getClient: () => client }, 1, undefined, logger, () => clock);
    const saved = state('active', 'inline');

    await redis.save(state('idle', big));
    clock = 1000;
    client.get.mockImplementation(key => key === 'sulla:threadstate:idle'
      ? new Promise(() => {})
      : Promise.resolve(client.values.get(key) ?? null));
    const roundTrip = redis.save(saved).then(() => redis.load('active'));

    // Both foreground commands resolve in microtasks; only the idle GET can stay pending.
    expect(await Promise.race([roundTrip, new Promise(resolve => setImmediate(() => resolve('stalled')))])).toEqual(saved);
    expect(client.get).toHaveBeenCalledWith('sulla:threadstate:idle');
  });

  it.each(['load', 'inline save', 'memory save'])('issues the foreground %s before a due FIFO probe', async(operation) => {
    const client = redisClient();
    const order: string[] = [];
    let tail: Promise<unknown> = Promise.resolve();
    const issue = <T>(command: string, run: () => T) => {
      order.push(command);
      const reply = tail.then(run);

      tail = reply;
      return reply;
    };

    client.get.mockImplementation(key => issue('GET ' + key, () => client.values.get(key) ?? null));
    client.setex.mockImplementation((key, _ttl, value) => issue('SETEX ' + key, () => {
      client.values.set(key, value);
      return 'OK';
    }));
    let clock = 0;
    const redis = new RedisThreadStateRepository({ getClient: () => client }, 1, undefined, logger, () => clock);
    const active = state('active', 'inline');

    await redis.save(state('idle', big));
    await redis.save(active);
    order.length = 0;
    clock = 1000;
    if (operation === 'load') expect(await redis.load('active')).toEqual(active);
    else await redis.save(operation === 'memory save' ? state('active', big) : active);
    const command = operation === 'load' ? 'GET' : 'SETEX';

    expect(order).toEqual([command + ' sulla:threadstate:active', 'GET sulla:threadstate:idle']);
  });

  it('retries a rejected probe after backoff even if error logging throws', async() => {
    const client = redisClient();
    const probeLogger = { log: vi.fn(), error: vi.fn() };
    let clock = 0;
    const redis = new RedisThreadStateRepository({ getClient: () => client }, 1, undefined, probeLogger, () => clock);
    const active = state('active', 'inline');

    await redis.save(state('idle', big));
    probeLogger.error.mockImplementationOnce(() => { throw new Error('logger unavailable') });
    client.get.mockRejectedValueOnce(new Error('probe unavailable'));
    clock = 1000;
    await redis.save(active);
    // Cross an event-loop turn so Vitest also observes any unhandled rejection.
    await new Promise(resolve => setImmediate(resolve));
    clock = 1999;
    await redis.save(active);
    expect(client.get).toHaveBeenCalledTimes(1);
    clock = 2000;
    await redis.save(active);
    expect(client.get.mock.calls).toEqual([['sulla:threadstate:idle'], ['sulla:threadstate:idle']]);
  });

  it('issues at most one outstanding probe per due head across concurrent saves', async() => {
    const client = redisClient();
    let clock = 0;
    const redis = new RedisThreadStateRepository({ getClient: () => client }, 1, undefined, logger, () => clock);
    const threads = ['a', 'b', 'c'];

    await Promise.all(threads.map(thread => redis.save(state(thread, big))));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve });
    client.get.mockImplementation(key => gate.then(() => client.values.get(key) ?? null));
    const saves = Array.from({ length: 16 }, (_, i) => {
      clock += 1000; // Even a probe older than the recheck interval is still in flight.
      return redis.save(state(String(i), 'inline'));
    });

    release();
    await Promise.all(saves);
    for (const thread of threads) {
      expect(client.get.mock.calls.filter(([key]) => key === 'sulla:threadstate:' + thread)).toHaveLength(1);
    }
  });

  it('backs off after a rejected probe and retries without exposing the error', async() => {
    const client = redisClient();
    const getClient = vi.fn(() => client);
    let clock = 0;
    const redis = new RedisThreadStateRepository({ getClient }, 3600, undefined, logger, () => clock);
    const active = state('active', 'inline');

    await redis.save(state('idle', big));
    logger.error.mockClear();
    const error = new Error('private-probe-marker');

    client.get.mockRejectedValueOnce(error).mockRejectedValueOnce(error);
    clock = 3600_000;
    await redis.save(active);
    clock += 59_999;
    await redis.save(active);
    expect(client.get).toHaveBeenCalledTimes(1);
    clock += 1;
    await redis.save(active);
    expect(client.get).toHaveBeenCalledTimes(2);
    clock += 60_000;
    getClient.mockReturnValueOnce(client).mockImplementationOnce(() => { throw error }); // Only the probe fails.
    await redis.save(active);
    expect(await redis.load('active')).toEqual(active);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls.flat().map(String).join(' ')).not.toContain('private-probe-marker');
  });

  it('falls through to real transcript recovery for an unreadable pointer without logging its payload', async() => {
    const client = redisClient();
    const badId = await files().write('thread', 'private-body: not JSON');
    client.values.set('sulla:threadstate:thread', JSON.stringify({ sullaCheckpointFile: 1, id: badId }));
    const log = path.join(directory, 'recovery.jsonl');
    await fs.promises.writeFile(log, JSON.stringify({ type: 'message', role: 'user', content: 'from log' }));
    const recovery = new LogRecoveryThreadStateRepository({
      getByThread: () => Promise.resolve({ id: 'tab', log_file: log } as ConversationHistoryRecord),
    });
    const repo = new FallbackThreadStateRepository(
      new RedisThreadStateRepository({ getClient: () => client }, 3600, files()),
      new MemoryThreadStateRepository(), recovery, logger,
    );
    expect((await repo.load('thread'))?.messages[0].content).toBe('from log');
    expect(logger.error).toHaveBeenCalled();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private-body');
  });

  it('ages published files from acknowledgement and sweeps only old payloads, temp files and legacy checkpoints', async() => {
    const now = Date.now();
    const repo = new FileThreadCheckpointRepository(() => directory, () => now);
    const old = await repo.write('thread', '{}');
    const [hash] = await fs.promises.readdir(directory);
    const folder = path.join(directory, hash);
    const payload = path.join(folder, old + '.json');
    const legacy = path.join(directory, hash + '.json');
    const temporary = payload + '.tmp';
    const unrelated = path.join(folder, 'notes.txt');
    const aged = new Date(now - 7201_000);
    for (const f of [legacy, temporary, unrelated]) await fs.promises.writeFile(f, 'fixture');
    for (const f of [payload, legacy, temporary, unrelated]) await fs.promises.utimes(f, aged, aged);
    await repo.published('thread', old);
    await repo.sweep(3600);
    expect(fs.existsSync(payload)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(temporary)).toBe(false);
    await fs.promises.utimes(payload, aged, aged);
    await repo.sweep(3600);
    expect(fs.existsSync(payload)).toBe(false);
  });
});

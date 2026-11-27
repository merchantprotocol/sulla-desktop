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

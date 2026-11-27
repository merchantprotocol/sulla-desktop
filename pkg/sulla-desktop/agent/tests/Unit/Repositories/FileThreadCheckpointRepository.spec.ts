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
  type ThreadStateRepository,
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

const noRecovery = (): ThreadStateRepository => ({
  save:   vi.fn(() => Promise.resolve()),
  delete: vi.fn(() => Promise.resolve()),
  load:   vi.fn(() => Promise.resolve(null)),
});

describe('large thread checkpoints', () => {
  let directory: string;

  beforeEach(async() => {
    directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'thread-checkpoints-'));
  });
  afterEach(async() => {
    await fs.promises.rm(directory, { recursive: true, force: true });
  });

  // A "process" is a fresh set of repositories over the same Redis data and checkpoint directory.
  const boot = (client: ReturnType<typeof redisClient>, logger = { log: vi.fn(), error: vi.fn() }) => new FallbackThreadStateRepository(
    new RedisThreadStateRepository({ getClient: () => client }),
    new MemoryThreadStateRepository(),
    noRecovery(),
    logger,
    new FileThreadCheckpointRepository(() => directory),
  );

  it('keeps a checkpoint larger than the Redis limit on disk and restores it after a restart', async() => {
    // risk: the 2026-11-23 Redis OOM — big threads must not go to Redis, and must survive restart
    const client = redisClient();
    const big = 'x'.repeat(MIB + 1);

    await boot(client).save(state('big-thread', big));

    expect(client.setex).not.toHaveBeenCalled();
    expect((await boot(client).load('big-thread'))?.messages[0].content).toBe(big);
  });

  it('never lets an older, smaller Redis copy win once the thread has a disk checkpoint', async() => {
    // risk: silent rollback of a conversation to a stale state after restart
    const client = redisClient();
    const repository = boot(client);

    await repository.save(state('growing', 'v1-small'));
    await repository.save(state('growing', 'x'.repeat(MIB + 1)));
    await repository.save(state('growing', 'v3-small-again'));

    expect(client.setex).toHaveBeenCalledTimes(1);
    expect(client.values.size).toBe(0);
    expect((await boot(client).load('growing'))?.messages[0].content).toBe('v3-small-again');
  });

  it('removes the disk checkpoint, Redis and memory copies on delete', async() => {
    // risk: deleted conversations resurrecting from disk
    const client = redisClient();
    const recovery = noRecovery();
    const repository = new FallbackThreadStateRepository(
      new RedisThreadStateRepository({ getClient: () => client }), new MemoryThreadStateRepository(), recovery,
      { log: vi.fn(), error: vi.fn() }, new FileThreadCheckpointRepository(() => directory),
    );

    await repository.save(state('gone', 'x'.repeat(MIB + 1)));
    await repository.delete('gone');

    expect(await fs.promises.readdir(directory)).toEqual([]);
    expect(await boot(client).load('gone')).toBeNull();
  });

  it('applies saves and deletes for one thread in the order they were issued', async() => {
    // risk: an overlapping delete/save pair leaves the wrong state behind
    const client = redisClient();
    const repository = boot(client);
    const big = 'x'.repeat(MIB + 1);

    await Promise.all([
      repository.save(state('raced', big)),
      repository.delete('raced'),
      repository.save(state('raced', 'after-delete')),
    ]);

    expect((await boot(client).load('raced'))?.messages[0].content).toBe('after-delete');
  });

  it('stores checkpoints under a hashed, owner-only file and leaves no temporary files', async() => {
    // risk: thread ids leaking into file names, world-readable conversation files, or disk litter
    const store = new FileThreadCheckpointRepository(() => path.join(directory, 'nested'));

    await store.save('thread/../secret-id', JSON.stringify(state('thread/../secret-id', 'private')));

    const files = await fs.promises.readdir(path.join(directory, 'nested'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.json$/);
    expect(files[0]).not.toContain('secret');
    if (process.platform !== 'win32') {
      expect((await fs.promises.stat(path.join(directory, 'nested', files[0]))).mode & 0o777).toBe(0o600);
    }
    expect(await store.exists('thread/../secret-id')).toBe(true);
    expect((await store.load('thread/../secret-id'))?.messages[0].content).toBe('private');
  });

  it.each(['stat', 'rename'])('uses Redis for small saves and memory for oversized saves after checkpoint %s fails', async(failure) => {
    const store = path.join(directory, 'store');
    const saved = path.join(directory, 'saved');
    const files = new FileThreadCheckpointRepository(() => store);
    const client = redisClient();
    const logger = { log: vi.fn(), error: vi.fn() };
    const memory = new MemoryThreadStateRepository();
    const repository = new FallbackThreadStateRepository(
      new RedisThreadStateRepository({ getClient: () => client }), memory, memory, logger, files,
    );
    for (const thread of ['small', 'large']) await files.save(thread, JSON.stringify(state(thread, 'old')));
    await fs.promises.rename(store, saved);
    if (failure === 'stat') {
      await fs.promises.writeFile(store, '');
    } else {
      await fs.promises.mkdir(store);
      for (const file of await fs.promises.readdir(saved)) await fs.promises.mkdir(path.join(store, file));
    }

    const large = 'private-body'.repeat(MIB / 10);
    await repository.save(state('small', 'private-body'));
    await repository.save(state('large', large));
    expect(client.setex).toHaveBeenCalledTimes(1);
    expect((await repository.load('small'))?.messages[0].content).toBe('private-body');
    await fs.promises.rm(store, { recursive: true });
    await fs.promises.rename(saved, store);

    expect((await repository.load('large'))?.messages[0].content === large).toBe(true);
    expect((await repository.load('small'))?.messages[0].content).toBe('private-body');
    await repository.save(state('small', 'new disk save'));
    expect((await repository.load('small'))?.messages[0].content).toBe('new disk save');
    expect(logger.error).toHaveBeenCalled();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private-body');
  });

  it('recovers the transcript after a malformed checkpoint without logging its contents', async() => {
    const files = new FileThreadCheckpointRepository(() => directory);
    await files.save('thread', 'private-body: not JSON');
    const log = path.join(directory, 'recovery.jsonl');
    await fs.promises.writeFile(log, JSON.stringify({ type: 'message', role: 'user', content: 'from log' }));
    const recovery = new LogRecoveryThreadStateRepository({
      getByThread: () => Promise.resolve({ id: 'tab', log_file: log } as ConversationHistoryRecord),
    });
    const client = redisClient();
    const logger = { log: vi.fn(), error: vi.fn() };
    const repo = new FallbackThreadStateRepository(
      new RedisThreadStateRepository({ getClient: () => client }), new MemoryThreadStateRepository(), recovery, logger, files,
    );
    expect((await repo.load('thread'))?.messages[0].content).toBe('from log');
    expect(logger.error).toHaveBeenCalled();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private-body');
  });

  it('refuses oversized Redis writes and keeps the checkpoint out of the error log', async() => {
    // risk: Redis OOM and full conversations copied into logs when no disk store is configured
    const client = redisClient();
    const logger = { log: vi.fn(), error: vi.fn() };
    const repository = new FallbackThreadStateRepository(
      new RedisThreadStateRepository({ getClient: () => client }), new MemoryThreadStateRepository(), noRecovery(), logger,
    );
    const marker = `private-marker-${ 'y'.repeat(MIB) }`;

    await repository.save(state('no-disk', marker));

    expect(client.setex).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private-marker');
    expect((await repository.load('no-disk'))?.messages[0].content).toBe(marker);
  });
});

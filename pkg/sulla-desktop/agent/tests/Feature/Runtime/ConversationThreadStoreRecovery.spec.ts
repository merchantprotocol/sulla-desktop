// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import crypto from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { postgresClient } from '@pkg/agent/database/PostgresClient';
import { ConversationThreadStore } from '@pkg/agent/database/models/ConversationThreadStore';
import { PostgresClient } from '@pkg/agent/database/PostgresClient';
import { TestDatabase } from '../../Support/TestDatabase';

const dbDescribe = TestDatabase.available() ? describe : describe.skip;
const databaseUrlBefore = process.env.SULLA_DATABASE_URL;
const poolMaxBefore = process.env.SULLA_DATABASE_POOL_MAX;
const classifierBefore = (postgresClient as any).classifier;

function snapshot(threadId: string, revision: string, messageId: string) {
  return {
    thread: { id: threadId, title: 'Recovery acceptance', messages: [{ id: messageId, role: 'assistant', content: revision }] },
    metadata: { revision },
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(accept => { resolve = accept });
  return { promise, resolve };
}

dbDescribe('ConversationThreadStore reconnect recovery against real PostgreSQL', () => {
  const db = new TestDatabase();
  const client = new PostgresClient();
  let pool: any;

  beforeAll(async() => {
    await db.initialize();
    process.env.SULLA_DATABASE_URL = db.appUrl();
    process.env.SULLA_DATABASE_POOL_MAX = '1';
    await client.initialize();
    pool = (client as any).pool;
    (postgresClient as any).classifier = null;
    vi.spyOn(postgresClient, 'transaction').mockImplementation((callback: any) => client.transaction(callback));
  }, 30_000);

  afterAll(async() => {
    vi.restoreAllMocks();
    await client.end();
    await db.dispose();
    if (databaseUrlBefore === undefined) delete process.env.SULLA_DATABASE_URL;
    else process.env.SULLA_DATABASE_URL = databaseUrlBefore;
    if (poolMaxBefore === undefined) delete process.env.SULLA_DATABASE_POOL_MAX;
    else process.env.SULLA_DATABASE_POOL_MAX = poolMaxBefore;
    (postgresClient as any).classifier = classifierBefore;
  }, 30_000);

  it('keeps same-thread FIFO through a refused first checkout while another thread read progresses', async() => {
    const threadId = `recovery-${ crypto.randomUUID() }`;
    const otherThreadId = `other-${ crypto.randomUUID() }`;
    const firstRefusal = deferred();
    const firstAttempt = deferred();
    const realConnect = pool.connect.bind(pool);
    const databasePort = Number(new URL(process.env.SULLA_DATABASE_URL!).port);
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', port: databasePort });
    let acquisitions = 0;
    pool.connect = async() => {
      acquisitions++;
      if (acquisitions === 1) {
        firstAttempt.resolve();
        await firstRefusal.promise;
        throw refused;
      }
      const pooledClient = await realConnect();
      await pooledClient.query(`SET search_path TO "${ db.schema }", public`);
      return pooledClient;
    };

    try {
      const older = ConversationThreadStore.saveThreadState(threadId, snapshot(threadId, 'older A', 'message-A'));
      await firstAttempt.promise;
      const latest = ConversationThreadStore.saveThreadState(threadId, snapshot(threadId, 'latest B', 'message-B'));

      await expect(ConversationThreadStore.getMessageCount(otherThreadId)).resolves.toBe(0);
      expect(acquisitions).toBe(2);

      firstRefusal.resolve();
      await expect(Promise.all([older, latest])).resolves.toEqual([threadId, threadId]);
      expect(acquisitions).toBe(4);
      const [storedHeader] = await db.query<{ thread_state: { metadata: { revision: string } } }>(
        'SELECT thread_state FROM conversation_history WHERE id = $1', [threadId]);
      const activeMessages = await db.query<{ content: string }>(
        'SELECT content FROM conversation_messages WHERE conversation_id = $1 AND deleted_at IS NULL ORDER BY position', [threadId]);
      expect(storedHeader.thread_state.metadata.revision).toBe('latest B');
      expect(activeMessages.map(message => message.content)).toEqual(['older A', 'latest B']);
    } finally {
      firstRefusal.resolve();
      pool.connect = realConnect;
    }
  });

  it('returns an exact durable readback receipt after a committed chat save loses its reply without replaying the write', async() => {
    const threadId = `receipt-${ crypto.randomUUID() }`;
    const realConnect = pool.connect.bind(pool);
    let lostCommitReply = true;
    let inserts = 0;
    const connectionLost = Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
    pool.connect = async() => {
      const pooledClient = await realConnect();
      await pooledClient.query(`SET search_path TO "${ db.schema }", public`);
      return new Proxy(pooledClient, {
        get(target, property) {
          if (property === 'query') return async(statement: string, params?: any[]) => {
            const result = await target.query(statement, params);
            if (statement.includes('INSERT INTO conversation_messages')) inserts++;
            if (statement === 'COMMIT' && lostCommitReply) {
              lostCommitReply = false;
              throw connectionLost;
            }
            return result;
          };
          if (property === 'release') return target.release.bind(target);
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };

    try {
      await expect(ConversationThreadStore.saveThreadState(threadId, snapshot(threadId, 'saved once', 'message-receipt'))).resolves.toBe(threadId);
      expect(lostCommitReply).toBe(false);
      expect(inserts).toBe(1);
      const [storedHeader] = await db.query<{ thread_state: { metadata: { revision: string } } }>(
        'SELECT thread_state FROM conversation_history WHERE id = $1', [threadId]);
      const activeMessages = await db.query<{ content: string }>(
        'SELECT content FROM conversation_messages WHERE conversation_id = $1 AND deleted_at IS NULL', [threadId]);
      expect(storedHeader.thread_state.metadata.revision).toBe('saved once');
      expect(activeMessages.map(message => message.content)).toEqual(['saved once']);
    } finally {
      pool.connect = realConnect;
    }
  });
});

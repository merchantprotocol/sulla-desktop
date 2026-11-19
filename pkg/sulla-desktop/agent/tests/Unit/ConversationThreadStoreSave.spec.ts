// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, describe, expect, it, vi } from 'vitest';

import { postgresClient } from '@pkg/agent/database/PostgresClient';
import { ConversationThreadStore } from '@pkg/agent/database/models/ConversationThreadStore';

import type { ChatThreadState, Queryable } from '@pkg/agent/database/models/ConversationThreadStore';

const threadId = 'thread-save-retry-test';
const previousDatabaseUrl = process.env.SULLA_DATABASE_URL;

function state(content: string, messageId: string): ChatThreadState {
  return { thread: { id: threadId, title: 'Test chat', messages: [{ id: messageId, role: 'assistant', content }] }, metadata: { revision: content } };
}

function fakeDatabase(onWrite?: (rows: any[]) => Promise<void>) {
  const writes: string[] = [];
  let savedState: any = null;
  let savedRows: any[] = [];
  const query = vi.fn(async(statement: string, params: any[] = []) => {
    if (statement.includes('SELECT id FROM conversation_history')) return { rows: [{ id: threadId }] };
    if (statement.includes('INSERT INTO conversation_messages')) {
      savedRows = JSON.parse(params[0]);
      writes.push(...savedRows.map(row => row.content));
      await onWrite?.(savedRows);
      return { rows: [] };
    }
    if (statement.includes('SET thread_state = $2::jsonb')) {
      savedState = JSON.parse(params[1]);
      return { rows: [] };
    }
    if (statement.includes('SELECT h.id, h.thread_id, h.title, h.thread_state')) {
      return { rows: [{ id: threadId, thread_id: threadId, title: 'Test chat', thread_state: savedState, messages: savedRows.map(row => row.payload) }] };
    }
    return { rows: [] };
  });
  return {
    database: { query } as unknown as Queryable,
    query,
    writes,
    get savedState() { return savedState },
    get savedRows() { return savedRows },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  if (previousDatabaseUrl === undefined) delete process.env.SULLA_DATABASE_URL;
  else process.env.SULLA_DATABASE_URL = previousDatabaseUrl;
});

describe('ConversationThreadStore snapshot save receipt', () => {
  it('serializes immutable same-thread snapshots so a slow older save cannot replace a later edit', async() => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve });
    const fixture = fakeDatabase(rows => rows[0]?.content === 'first' ? firstGate : Promise.resolve());
    vi.spyOn(postgresClient, 'transaction').mockImplementation(async(callback: any) => callback(fixture.database));

    const older = state('first', 'message-1');
    const first = ConversationThreadStore.saveThreadState(threadId, older);
    const second = ConversationThreadStore.saveThreadState(threadId, state('latest', 'message-2'));
    older.thread.messages[0].content = 'mutated after save began';
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(fixture.writes).toEqual(['first']);

    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([threadId, threadId]);
    expect(fixture.writes).toEqual(['first', 'latest']);
  });

  it('keeps FIFO ordering across delayed connection acquisition so the latest snapshot wins', async() => {
    process.env.SULLA_DATABASE_URL = 'postgres://sulla:unused@127.0.0.1:30116/sulla';
    const fixture = fakeDatabase();
    const previousClientState = {
      pool: (postgresClient as any).pool,
      connected: (postgresClient as any).connected,
      shuttingDown: (postgresClient as any).shuttingDown,
      classifier: (postgresClient as any).classifier,
      socketOutage: (postgresClient as any).socketOutage,
    };
    let releaseFirstRefusal!: () => void;
    let firstAcquisitionStarted!: () => void;
    const firstRefusal = new Promise<void>(resolve => { releaseFirstRefusal = resolve });
    const acquisitionStarted = new Promise<void>(resolve => { firstAcquisitionStarted = resolve });
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', port: 30116 });
    let acquisitionCount = 0;
    const client = {
      query: (statement: string, params?: any[]) => fixture.database.query(statement, params),
      release: vi.fn(),
    };
    (postgresClient as any).pool = {
      connect: async() => {
        acquisitionCount++;
        if (acquisitionCount === 1) {
          firstAcquisitionStarted();
          await firstRefusal;
          throw refused;
        }
        return client;
      },
    };
    (postgresClient as any).connected = true;
    (postgresClient as any).shuttingDown = false;
    (postgresClient as any).classifier = null;

    try {
      const older = ConversationThreadStore.saveThreadState(threadId, state('older snapshot', 'message-old'));
      await acquisitionStarted;
      const latest = ConversationThreadStore.saveThreadState(threadId, state('latest snapshot', 'message-latest'));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(acquisitionCount).toBe(1);

      releaseFirstRefusal();
      await expect(Promise.all([older, latest])).resolves.toEqual([threadId, threadId]);
      expect(acquisitionCount).toBe(3);
      expect(fixture.writes).toEqual(['older snapshot', 'latest snapshot']);
      expect(fixture.savedRows.map(row => row.content)).toEqual(['latest snapshot']);
      expect(fixture.savedState.metadata.revision).toBe('latest snapshot');
    } finally {
      releaseFirstRefusal();
      (postgresClient as any).pool = previousClientState.pool;
      (postgresClient as any).connected = previousClientState.connected;
      (postgresClient as any).shuttingDown = previousClientState.shuttingDown;
      (postgresClient as any).classifier = previousClientState.classifier;
      (postgresClient as any).socketOutage = previousClientState.socketOutage;
    }
  });

  it('uses exact readback as the durable receipt after a lost commit reply without replaying the write', async() => {
    process.env.SULLA_DATABASE_URL = 'postgres://sulla:unused@127.0.0.1:30116/sulla';
    const fixture = fakeDatabase();
    const lostCommitReply = Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET', port: 30116 });
    let transactionCount = 0;
    vi.spyOn(postgresClient, 'transaction').mockImplementation(async(callback: any) => {
      transactionCount++;
      const result = await callback(fixture.database);
      if (transactionCount === 1) throw lostCommitReply;
      return result;
    });

    await expect(ConversationThreadStore.saveThreadState(threadId, state('saved once', 'message-1'))).resolves.toBe(threadId);
    expect(transactionCount).toBe(2); // one write, one read-only receipt check
    expect(fixture.writes).toEqual(['saved once']);
    expect(fixture.query.mock.calls.filter(([statement]) => statement.includes('INSERT INTO conversation_messages'))).toHaveLength(1);
  });
});

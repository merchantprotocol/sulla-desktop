/** @jest-environment node */
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { Client, Pool } from 'pg';

const baseUrl = process.env.SULLA_TEST_PG_URL;
const describeDatabase = baseUrl ? describe : describe.skip;
const scratch = `sulla_history_actions_${ process.pid }`;

describeDatabase('conversation history actions and durable resume', () => {
  let admin: Client;
  let pool: Pool;
  let history: typeof import('../ConversationHistoryModel').ConversationHistoryModel;
  let threads: typeof import('../ConversationThreadStore');

  const q = async(text: string, params: any[] = []) => (await pool.query(text, params)).rows;
  const tx = async<T>(fn: (client: any) => Promise<T>) => {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  };

  beforeAll(async() => {
    admin = new Client({ connectionString: baseUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${ scratch }`);
    await admin.query(`CREATE DATABASE ${ scratch }`);
    const url = new URL(baseUrl!); url.pathname = `/${ scratch }`;
    pool = new Pool({ connectionString: url.toString() });
    await pool.query(`
      CREATE TABLE conversation_history (
        id TEXT PRIMARY KEY, thread_id TEXT, type TEXT NOT NULL, title TEXT, summary TEXT,
        status TEXT NOT NULL DEFAULT 'active', pinned BOOLEAN NOT NULL DEFAULT FALSE,
        archived BOOLEAN NOT NULL DEFAULT FALSE, hidden BOOLEAN NOT NULL DEFAULT FALSE,
        deleted_at TIMESTAMPTZ, source TEXT, message_count INTEGER NOT NULL DEFAULT 0,
        last_message_preview TEXT, thread_state JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_active_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE conversation_messages (
        seq BIGSERIAL PRIMARY KEY, id TEXT UNIQUE NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversation_history(id) ON DELETE CASCADE,
        role TEXT NOT NULL, content TEXT, tool_calls JSONB, tool_call_id TEXT, tool_name TEXT, tool_result JSONB,
        model TEXT, status TEXT, kind TEXT, turn_id TEXT, position INTEGER, payload JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), deleted_at TIMESTAMPTZ
      );
    `);
    const { postgresClient } = await import('../../PostgresClient');
    jest.spyOn(postgresClient, 'query').mockImplementation(async(text: string, params: any[] = []) => (await pool.query(text, params)).rows as any);
    jest.spyOn(postgresClient, 'queryOne').mockImplementation(async(text: string, params: any[] = []) => (await pool.query(text, params)).rows[0] ?? null);
    jest.spyOn(postgresClient, 'transaction').mockImplementation((callback: any) => tx(callback));
    history = (await import('../ConversationHistoryModel')).ConversationHistoryModel;
    threads = await import('../ConversationThreadStore');
  }, 60_000);

  afterAll(async() => {
    jest.restoreAllMocks();
    await pool?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${ scratch }`); await admin.end() }
  });

  it('persists rename, pin order, archive view, and recoverable delete across fresh reads', async() => {
    await q(`INSERT INTO conversation_history (id, thread_id, type, title, last_active_at) VALUES
      ('older', 'thread-older', 'chat', 'Older', now() - interval '1 day'),
      ('newer', 'thread-newer', 'chat', 'Newer', now())`);

    await history.update('older', { title: 'Renamed', pinned: true });
    expect((await history.list('active')).map(row => row.id)).toEqual(['older', 'newer']);
    expect((await history.getById('older'))?.title).toBe('Renamed');

    await history.update('older', { archived: true });
    expect((await history.list('active')).map(row => row.id)).toEqual(['newer']);
    expect((await history.list('archived')).map(row => row.id)).toEqual(['older']);
    expect((await history.searchView('Renamed', 'archived'))[0]).toMatchObject({ id: 'older', archived: true });

    await history.update('older', { archived: false, deleted: true });
    expect(await history.list('active')).toHaveLength(1);
    expect((await history.list('deleted'))[0].id).toBe('older');
    await history.update('older', { deleted: false });
    expect((await history.list('active')).map(row => row.id)).toEqual(['older', 'newer']);
  });

  it('reloads every message in order and appends new turns to the same durable thread', async() => {
    await q(`INSERT INTO conversation_history (id, thread_id, type, title) VALUES ('tab-resume', 'thread-resume', 'chat', 'Resume')`);
    const first = {
      thread: {
        id:       'thread-resume',
        title:    'Resume',
        messages: [
          { id: 'm1', kind: 'user', text: 'one', createdAt: 1 },
          { id: 'm2', kind: 'sulla', text: 'two', createdAt: 2 },
        ],
      },
      runState: { providerThreadId: 'provider-1' },
    } as any;
    await tx(client => threads.saveThreadStateWith(client, 'thread-resume', first));
    const reloaded = await tx(client => threads.loadThreadStateWith(client, 'tab-resume'));
    expect(reloaded?.thread.messages.map((message: any) => message.text)).toEqual(['one', 'two']);
    expect((reloaded as any).runState.providerThreadId).toBe('provider-1');

    reloaded!.thread.messages.push({ id: 'm3', kind: 'user', text: 'three', createdAt: 3 });
    await tx(client => threads.saveThreadStateWith(client, 'thread-resume', reloaded!));
    const afterRestart = await tx(client => threads.loadThreadStateWith(client, 'thread-resume'));
    expect(afterRestart?.thread.messages.map((message: any) => message.text)).toEqual(['one', 'two', 'three']);
    expect((await q(`SELECT DISTINCT conversation_id FROM conversation_messages`))).toEqual([{ conversation_id: 'tab-resume' }]);
  });
});

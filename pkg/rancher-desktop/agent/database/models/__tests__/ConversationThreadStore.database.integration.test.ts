/** @jest-environment node */
// Real-Postgres integration test for the stage-2 unified conversations store.
// Gated on SULLA_TEST_PG_URL; it creates (and drops) its own scratch database
// next to the one in the URL, so the target database itself is never touched.
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { Client, Pool } from 'pg';

import { graphMessages, uiMessages, uiState } from './fixtures/threadMessages';

const baseUrl = process.env.SULLA_TEST_PG_URL;
const describeDatabase = baseUrl ? describe : describe.skip;
const SCRATCH_DB = `sulla_stage2_it_${ process.pid }`;

/** Recursively sort object keys so JSON text comparison ignores jsonb key order. */
function canonical(v: any): any {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
  return v;
}
const canon = (v: any) => JSON.stringify(canonical(v));

describeDatabase('ConversationThreadStore on a real PostgreSQL database', () => {
  let admin: Client;
  let pool: Pool;
  let store: typeof import('../ConversationThreadStore');
  let up0128: string;

  async function tx<T>(fn: (c: any) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  const q = async(sql: string, params: any[] = []) => (await pool.query(sql, params)).rows;
  const save = (id: string, state: any) => tx(c => store.saveThreadStateWith(c, id, state));
  const load = (id: string) => tx(c => store.loadThreadStateWith(c, id));

  beforeAll(async() => {
    admin = new Client({ connectionString: baseUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${ SCRATCH_DB }`);
    await admin.query(`CREATE DATABASE ${ SCRATCH_DB }`);
    const url = new URL(baseUrl!);
    url.pathname = `/${ SCRATCH_DB }`;
    pool = new Pool({ connectionString: url.toString(), max: 12 });

    // Route the module-level postgresClient (used by ConversationHistoryModel.linkThreads
    // and the ConversationThreadStore wrappers) to the scratch database.
    const { postgresClient } = await import('../../PostgresClient');
    jest.spyOn(postgresClient, 'query').mockImplementation(async(text: string, params: any[] = []) => (await pool.query(text, params)).rows as any);
    jest.spyOn(postgresClient, 'transaction').mockImplementation((cb: any) => tx(cb));

    store = await import('../ConversationThreadStore');
    const { migrationsRegistry } = await import('../../migrations/index');
    for (const m of migrationsRegistry) {
      if (m.name.startsWith('0128')) {
        up0128 = m.up as string;
        break;
      }
      try {
        if (typeof m.up === 'function') await tx(c => (m.up as any)(c));
        else await pool.query(m.up);
      } catch { /* a few function-style migrations need app services — irrelevant here */ }
    }
    expect(typeof up0128).toBe('string');
  }, 120_000);

  afterAll(async() => {
    jest.restoreAllMocks();
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${ SCRATCH_DB }`);
      await admin.end();
    }
  });

  describe('migration 0128', () => {
    it('imports a legacy chat_messages table, then re-runs idempotently', async() => {
      // Pre-0128 world: a tab row linked to thread A; thread B has no header.
      await q(`INSERT INTO conversation_history (id, thread_id, type, title, status, pinned) VALUES ('tab_legacyA', 't_legacyA', 'chat', 'Legacy tab', 'active', TRUE)`);
      await q(`INSERT INTO conversation_messages (id, conversation_id, role, content) VALUES ('claude-1', 'tab_legacyA', 'assistant', 'from stage 1')`);
      await q(`CREATE TABLE chat_messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, state_json JSONB NOT NULL, message_count INTEGER DEFAULT 0,
                 created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())`);
      await q(`INSERT INTO chat_messages (id, thread_id, state_json) VALUES ($1, $1, $2), ($3, $3, $4)`, [
        't_legacyA', JSON.stringify(uiState('t_legacyA')),
        't_legacyB', JSON.stringify({ thread: { id: 't_legacyB', title: 'Worker B', messages: graphMessages() } }),
      ]);

      await pool.query(up0128);

      const cols = await q(`SELECT table_name, column_name FROM information_schema.columns
        WHERE (table_name = 'conversation_messages' AND column_name IN ('kind','turn_id','position','payload'))
           OR (table_name = 'conversation_history' AND column_name = 'thread_state')`);
      expect(cols).toHaveLength(5);
      expect((await q(`SELECT kind FROM conversation_messages WHERE id = 'claude-1'`))[0].kind).toBe('sulla');

      // Thread A landed on the existing tab row (title/pinned untouched), byte-identical.
      const a = await load('tab_legacyA');
      expect(canon(a)).toBe(canon(uiState('t_legacyA')));
      expect(await load('t_legacyA')).toEqual(a);
      const [tabA] = await q(`SELECT title, pinned, hidden, message_count, last_message_preview FROM conversation_history WHERE id = 'tab_legacyA'`);
      expect(tabA).toMatchObject({ title: 'Legacy tab', pinned: true, hidden: false, message_count: uiMessages().length + 1 });
      expect(tabA.last_message_preview).toBe('Partial answ');

      // Thread B got a hidden placeholder header.
      const [phB] = await q(`SELECT id, thread_id, type, hidden, source, title FROM conversation_history WHERE id = 't_legacyB'`);
      expect(phB).toEqual({ id: 't_legacyB', thread_id: 't_legacyB', type: 'chat', hidden: true, source: 'thread-placeholder', title: 'Worker B' });
      expect((await load('t_legacyB'))!.thread.messages).toEqual(graphMessages());

      // SQL import and the JS mapper agree on every mapped column.
      const sqlRows = await q(`SELECT id, position, kind, role, content, turn_id, tool_name, tool_call_id, tool_calls, tool_result, model, status
        FROM conversation_messages WHERE payload IS NOT NULL AND conversation_id IN ('tab_legacyA','t_legacyB')`);
      const jsRows = [
        ...store.threadStateToRows('t_legacyB', { thread: { id: 't_legacyB', messages: graphMessages() } }),
        ...store.threadStateToRows('t_legacyA', uiState('t_legacyA')),
      ].map(({ payload, created_ms: _createdMs, ...r }) => r);
      const byId = (x: any, y: any) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
      expect(sqlRows.sort(byId)).toEqual(jsRows.sort(byId));

      const before = await q(`SELECT (SELECT COUNT(*)::int FROM conversation_messages) AS m, (SELECT COUNT(*)::int FROM conversation_history) AS h`);
      await pool.query(up0128);
      await pool.query(up0128);
      const after = await q(`SELECT (SELECT COUNT(*)::int FROM conversation_messages) AS m, (SELECT COUNT(*)::int FROM conversation_history) AS h`);
      expect(after).toEqual(before);
      expect((await q(`SELECT to_regclass('chat_messages') IS NOT NULL AS kept`))[0].kept).toBe(true);
    });

    it('runs cleanly on a database that never had chat_messages', async() => {
      await q(`ALTER TABLE chat_messages RENAME TO chat_messages_parked`);
      await expect(pool.query(up0128)).resolves.toBeDefined();
      await q(`ALTER TABLE chat_messages_parked RENAME TO chat_messages`);
    });
  });

  describe('save / load', () => {
    it('round-trips every message kind byte-identically via a placeholder header', async() => {
      const state = uiState('t_rt');
      const headerId = await save('t_rt', state);
      expect(headerId).toBe('t_rt');
      const loaded = await load('t_rt');
      expect(loaded).toEqual(state);
      expect(canon(loaded)).toBe(canon(state));
      const [h] = await q(`SELECT hidden, source, type, message_count, last_message_preview, thread_state FROM conversation_history WHERE id = 't_rt'`);
      expect(h).toMatchObject({ hidden: true, source: 'thread-placeholder', type: 'chat', message_count: 20, last_message_preview: 'Partial answ' });
      expect(h.thread_state.thread.messages).toEqual([]);
      expect(h.thread_state.runState).toBe('idle');
      const kinds = await q(`SELECT DISTINCT kind FROM conversation_messages WHERE conversation_id = 't_rt'`);
      expect(kinds).toHaveLength(19);
      const tool = (await q(`SELECT role, tool_name, tool_call_id, tool_calls, tool_result FROM conversation_messages WHERE id = 't_rt:m03'`))[0];
      expect(tool).toEqual({
        role:         'tool',
        tool_name:    'Grep',
        tool_call_id: 'm03',
        tool_calls:   [{ id: 'm03', name: 'Grep', arguments: '{"pattern":"GuestBridge"}' }],
        tool_result:  { status: 'ok', output: 'a.ts:1\nb.ts:2', error: null, meta: '8 hits · 120ms' },
      });
      expect((await q(`SELECT created_at FROM conversation_messages WHERE id = 't_rt:m01'`))[0].created_at.getTime()).toBe(uiMessages()[0].createdAt);
    });

    it('re-save with changed / removed / added messages soft-deletes, never duplicates, keeps seq', async() => {
      const seqBefore = Object.fromEntries((await q(`SELECT id, seq FROM conversation_messages WHERE conversation_id = 't_rt'`)).map(r => [r.id, String(r.seq)]));
      const msgs = uiMessages();
      msgs[19] = { ...msgs[19], kind: 'sulla', text: 'Full answer', model: 'opus-4.7' }; // streaming → final
      msgs.splice(14, 2); // drop tts + interim
      msgs.push({ id: 'm21', kind: 'user', createdAt: Date.now(), text: 'thanks!' });
      await save('t_rt', uiState('t_rt', msgs));

      expect((await load('t_rt'))!.thread.messages).toEqual(msgs);
      const rows = await q(`SELECT id, seq, deleted_at, kind, position FROM conversation_messages WHERE conversation_id = 't_rt' ORDER BY seq`);
      expect(rows).toHaveLength(21);
      expect(new Set(rows.map(r => r.id)).size).toBe(21);
      expect(rows.filter(r => r.deleted_at).map(r => r.id).sort()).toEqual(['t_rt:m15', 't_rt:m16']);
      for (const r of rows) if (seqBefore[r.id]) expect(String(r.seq)).toBe(seqBefore[r.id]);
      expect(rows.find(r => r.id === 't_rt:m20')).toMatchObject({ kind: 'sulla', position: 17 });
      const [h] = await q(`SELECT message_count, last_message_preview FROM conversation_history WHERE id = 't_rt'`);
      expect(h).toEqual({ message_count: 19, last_message_preview: 'thanks!' });

      // Unchanged re-save touches no rows; re-adding a removed message revives the same row.
      const stamp = (await q(`SELECT max(updated_at) AS t FROM conversation_messages WHERE conversation_id = 't_rt'`))[0].t;
      await save('t_rt', uiState('t_rt', msgs));
      expect((await q(`SELECT max(updated_at) AS t FROM conversation_messages WHERE conversation_id = 't_rt'`))[0].t).toEqual(stamp);
      await save('t_rt', uiState('t_rt', uiMessages()));
      expect((await load('t_rt'))!.thread.messages).toEqual(uiMessages());
      expect((await q(`SELECT seq FROM conversation_messages WHERE id = 't_rt:m15'`))[0].seq).toBe(seqBefore['t_rt:m15']);
    });

    it('delete soft-deletes payload rows and clears thread_state; count follows', async() => {
      await save('t_del', uiState('t_del'));
      expect(await tx(c => store.getMessageCountWith(c, 't_del'))).toBe(20);
      await tx(c => store.deleteThreadStateWith(c, 't_del'));
      expect(await load('t_del')).toBeNull();
      expect(await tx(c => store.getMessageCountWith(c, 't_del'))).toBe(0);
      expect((await q(`SELECT COUNT(*)::int AS n FROM conversation_messages WHERE conversation_id = 't_del' AND deleted_at IS NOT NULL`))[0].n).toBe(20);
      expect(await load('does-not-exist')).toBeNull();
      expect(await tx(c => store.getMessageCountWith(c, 'does-not-exist'))).toBe(0);
    });
  });

  describe('placeholder adoption', () => {
    it('linkThreads moves the transcript onto the tab row and removes the placeholder (idempotent)', async() => {
      const state = uiState('t_adopt');
      await save('t_adopt', state);
      await q(`INSERT INTO conversation_history (id, type, title, status, pinned) VALUES ('tab_adopt', 'chat', 'My tab', 'active', TRUE)`);

      const { ConversationHistoryModel } = await import('../ConversationHistoryModel');
      await ConversationHistoryModel.linkThreads([{ id: 'tab_adopt', threadId: 't_adopt' }]);

      expect(await q(`SELECT id FROM conversation_history WHERE id = 't_adopt'`)).toHaveLength(0);
      const [tab] = await q(`SELECT thread_id, title, pinned, hidden, message_count, thread_state FROM conversation_history WHERE id = 'tab_adopt'`);
      expect(tab).toMatchObject({ thread_id: 't_adopt', title: 'My tab', pinned: true, hidden: false, message_count: 20 });
      expect(tab.thread_state.queue).toEqual(state.queue);
      expect((await q(`SELECT COUNT(*)::int AS n FROM conversation_messages WHERE conversation_id = 'tab_adopt'`))[0].n).toBe(20);
      expect(await load('tab_adopt')).toEqual(state);
      expect(await load('t_adopt')).toEqual(state);

      await ConversationHistoryModel.linkThreads([{ id: 'tab_adopt', threadId: 't_adopt' }]);
      expect(await tx(c => store.adoptThreadMessagesWith(c, 'tab_adopt', 't_adopt'))).toBe(false);
      expect(await load('tab_adopt')).toEqual(state);

      // Later renderer saves (by thread id) hit the tab row, never a new placeholder, and keep its title.
      const next = uiState('t_adopt', [...uiMessages(), { id: 'm99', kind: 'user', createdAt: Date.now(), text: 'after link' }]);
      next.thread.title = 'Renamed in renderer';
      expect(await save('t_adopt', next)).toBe('tab_adopt');
      expect(await q(`SELECT id FROM conversation_history WHERE id = 't_adopt'`)).toHaveLength(0);
      expect((await q(`SELECT title, message_count FROM conversation_history WHERE id = 'tab_adopt'`))[0]).toEqual({ title: 'My tab', message_count: 21 });
    });

    it('a save folds in a placeholder when the tab row was linked before adoption ran', async() => {
      await save('t_late', uiState('t_late'));
      await q(`INSERT INTO conversation_history (id, thread_id, type, title, status) VALUES ('tab_late', 't_late', 'chat', 'Late', 'active')`);
      expect(await save('t_late', uiState('t_late'))).toBe('tab_late');
      expect(await q(`SELECT id FROM conversation_history WHERE id = 't_late'`)).toHaveLength(0);
      expect((await q(`SELECT COUNT(*)::int AS n FROM conversation_messages WHERE conversation_id = 'tab_late' AND deleted_at IS NULL`))[0].n).toBe(20);
    });
  });

  describe('graph conversations', () => {
    it('a graph-type header receives the worker transcript', async() => {
      await q(`INSERT INTO conversation_history (id, thread_id, type, title, status) VALUES ('g_worker', 'g_worker', 'graph', 'Worker', 'active')`);
      const state = { thread: { id: 'g_worker', title: 'opus-worker', messages: graphMessages() } };
      expect(await tx(c => store.saveThreadStateWith(c, 'g_worker', state))).toBe('g_worker');
      expect(await q(`SELECT id FROM conversation_history WHERE source = 'thread-placeholder' AND id = 'g_worker'`)).toHaveLength(0);
      expect(await load('g_worker')).toEqual(state);
      const [h] = await q(`SELECT type, title, message_count, last_message_preview FROM conversation_history WHERE id = 'g_worker'`);
      expect(h).toEqual({ type: 'graph', title: 'Worker', message_count: 5, last_message_preview: 'Done.\nTwo files.' });
      const roles = await q(`SELECT role, kind, tool_call_id FROM conversation_messages WHERE conversation_id = 'g_worker' ORDER BY position`);
      expect(roles.map(r => `${ r.role }/${ r.kind }`)).toEqual(['system/system', 'user/user', 'assistant/sulla', 'tool/tool', 'assistant/sulla']);
      expect(roles[3].tool_call_id).toBe('call_1');
    });

    it('works through the postgresClient-backed wrapper too', async() => {
      await store.ConversationThreadStore.saveThreadState('g_wrap', { thread: { id: 'g_wrap', title: 'w', messages: graphMessages() } });
      expect((await store.ConversationThreadStore.loadThreadState('g_wrap'))!.thread.messages).toEqual(graphMessages());
      expect(await store.ConversationThreadStore.getMessageCount('g_wrap')).toBe(5);
    });
  });

  describe('concurrency', () => {
    it('parallel saves of one brand-new thread neither duplicate nor deadlock', async() => {
      const all = uiMessages();
      const states = Array.from({ length: 10 }, (_, i) => uiState('t_conc', all.slice(0, 10 + i)));
      await Promise.all(states.map(s => save('t_conc', s)));
      expect(await q(`SELECT id FROM conversation_history WHERE id = 't_conc' OR thread_id = 't_conc'`)).toHaveLength(1);
      const live = await q(`SELECT id FROM conversation_messages WHERE conversation_id = 't_conc' AND deleted_at IS NULL`);
      const loaded = await load('t_conc');
      expect(live).toHaveLength(loaded!.thread.messages.length);
      expect(states.map(s => canon(s))).toContain(canon(loaded));
      const total = await q(`SELECT COUNT(*)::int AS n, COUNT(DISTINCT id)::int AS d FROM conversation_messages WHERE conversation_id = 't_conc'`);
      expect(total[0].n).toBe(total[0].d);
      expect(total[0].n).toBeLessThanOrEqual(19);
    });
  });
});

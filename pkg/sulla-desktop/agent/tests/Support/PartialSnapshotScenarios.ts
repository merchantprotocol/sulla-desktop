// SPDX-License-Identifier: GPL-2.0-or-later
// Shared write-safety scenarios for ConversationThreadStore. They execute the store's real SQL
// against a real PostgreSQL engine (PGlite in unit runs, the migrated test database in feature runs).
import { expect, vi } from 'vitest';

import { postgresClient } from '@pkg/agent/database/PostgresClient';
import { ConversationThreadStore, deleteMessagesWith, loadThreadStateWith, saveThreadStateWith } from '@pkg/agent/database/models/ConversationThreadStore';

import type { ChatThreadState, Queryable } from '@pkg/agent/database/models/ConversationThreadStore';

export interface ScenarioDatabase extends Queryable {
  /** Runs one transaction on a single connection (BEGIN/COMMIT), like PostgresClient.transaction. */
  transaction<T>(work: (client: Queryable) => Promise<T>, afterCommit?: () => void): Promise<T>;
}

const message = (index: number, text = `canonical ${ index }`) => ({ id: `m${ index }`, kind: 'user', text, createdAt: 1_794_000_000_000 + index });

export function canonicalState(threadId: string, count: number): ChatThreadState {
  return {
    thread: { id: threadId, title: 'T&B Staging Test', messages: Array.from({ length: count }, (_, index) => message(index)) },
    queue: [], model: { id: 'claude-opus-5-5', name: 'opus-5.5' },
  };
}

async function rows(db: Queryable, conversationId: string) {
  return (await db.query(
    'SELECT id, position, payload, status, deleted_at FROM conversation_messages WHERE conversation_id = $1 ORDER BY position, seq',
    [conversationId],
  )).rows.map(row => ({ ...row, deleted_at: row.deleted_at ? new Date(row.deleted_at).toISOString() : null }));
}

/** A browser cache view: the recent tail (with stale copies and an old tombstoned row), plus one new message. */
function partialView(threadId: string): ChatThreadState {
  const tail = Array.from({ length: 60 }, (_, offset) => message(921 + offset, offset === 9 ? 'stale cached edit' : undefined));
  return {
    thread: { id: threadId, title: 'T&B Staging Test', messages: [message(10, 'stale copy of a deleted row'), ...tail, { id: 'human-new', kind: 'user', text: 'new while partial', createdAt: 1_795_000_000_000 }] },
    queue: [{ id: 'queued-1', text: 'queued while partial' }],
    model: { id: 'grok-4.7', name: 'Grok 4.7' },
    partialHistory: true,
  };
}

export async function partialSnapshotKeepsCanonicalHistory(db: Queryable): Promise<void> {
  await saveThreadStateWith(db, 'T', canonicalState('T', 981));
  await saveThreadStateWith(db, 'O', canonicalState('O', 3));
  // An intentional older tombstone must stay exactly as it is.
  await db.query(`UPDATE conversation_messages SET deleted_at = '2026-11-15T10:00:00Z' WHERE id = 'T:m10'`);
  const before = await rows(db, 'T');
  const otherBefore = await rows(db, 'O');
  expect(before).toHaveLength(981);

  await saveThreadStateWith(db, 'T', partialView('T'));
  await saveThreadStateWith(db, 'T', partialView('T'));

  const after = await rows(db, 'T');
  expect(after.filter(row => row.id !== 'T:human-new')).toEqual(before);
  const added = after.filter(row => row.id === 'T:human-new');
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ position: 981, deleted_at: null, payload: { text: 'new while partial' } });
  expect(await rows(db, 'O')).toEqual(otherBefore);

  const loaded = await loadThreadStateWith(db, 'T');
  expect(loaded).not.toHaveProperty('partialHistory');
  expect(loaded?.queue).toEqual([{ id: 'queued-1', text: 'queued while partial' }]);
  expect(loaded?.model).toMatchObject({ id: 'grok-4.7' });
  expect(loaded?.thread.messages).toHaveLength(981);
  expect(loaded?.thread.messages.at(-1)).toMatchObject({ id: 'human-new' });
  expect(loaded?.thread.messages.find((item: any) => item.id === 'm930')).toMatchObject({ text: 'canonical 930' });
}

export async function completeSnapshotStillRemovesExplicitly(db: Queryable): Promise<void> {
  await saveThreadStateWith(db, 'C', canonicalState('C', 20));
  await db.query(`UPDATE conversation_messages SET deleted_at = '2026-11-15T10:00:00Z' WHERE id = 'C:m3'`);
  const full = (await loadThreadStateWith(db, 'C'))!;
  const before = await rows(db, 'C');
  await saveThreadStateWith(db, 'C', { ...full, thread: { ...full.thread, messages: full.thread.messages.filter((item: any) => item.id !== 'm7') } });
  expect(await rows(db, 'C')).toEqual(before);
  await deleteMessagesWith(db, 'C', ['m7']);
  const after = await rows(db, 'C');
  const changed = after.filter((row, index) => row.deleted_at !== before[index].deleted_at).map(row => row.id);
  expect(changed).toEqual(['C:m7']);
  expect(after.find(row => row.id === 'C:m3')?.deleted_at).toBe('2026-11-15T10:00:00.000Z');
}

export async function lostCommitOfPartialIsNotClaimedOrReplayed(db: ScenarioDatabase): Promise<void> {
  await saveThreadStateWith(db, 'L', canonicalState('L', 981));
  let lostOnce = true;
  const lost = Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
  const spy = vi.spyOn(postgresClient, 'transaction').mockImplementation((work: any) => db.transaction(work, () => {
    if (lostOnce) { lostOnce = false; throw lost }
  }));
  try {
    const save = ConversationThreadStore.saveThreadState('L', partialView('L'));
    await expect(save).rejects.toBe(lost);
    // The write did commit once; it is neither replayed nor reported as a matching full readback.
    const added = (await db.query(`SELECT count(*)::int AS n FROM conversation_messages WHERE id = 'L:human-new'`)).rows[0].n;
    expect(added).toBe(1);
    expect((await rows(db, 'L')).filter(row => row.deleted_at)).toEqual([]);
  } finally { spy.mockRestore() }
}

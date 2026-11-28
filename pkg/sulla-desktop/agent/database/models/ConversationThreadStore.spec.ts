// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { saveThreadStateWith, type Queryable } from './ConversationThreadStore';

class MemoryConversationDb implements Queryable {
  readonly messages = new Map<string, { id: string; position: number; payload: unknown }>();

  async query(text: string, params: any[] = []): Promise<{ rows: any[]; rowCount?: number | null }> {
    if (text.includes('FROM conversation_history') && text.includes('LIMIT 1')) return { rows: [{ id: 'thread-a' }] };
    if (text.includes('SELECT id, position FROM conversation_messages')) {
      return { rows: [...this.messages.values()].map(({ id, position }) => ({ id, position })) };
    }
    if (text.includes('INSERT INTO conversation_messages')) {
      for (const row of JSON.parse(params[0])) this.messages.set(row.id, row);
    }
    return { rows: [] };
  }
}

const stateWith = (messages: any[]) => ({ thread: { id: 'thread-a', title: 'Chat', messages } });

describe('ConversationThreadStore bounded-window persistence', () => {
  it('merges a bounded save without deleting older durable messages or moving existing positions', async() => {
    // risk: permanent loss of chat history when a renderer window is saved
    const db = new MemoryConversationDb();
    await saveThreadStateWith(db, 'thread-a', stateWith([
      { id: 'old', kind: 'user', text: 'earlier' },
      { id: 'recent', kind: 'sulla', text: 'current answer' },
    ]) as any);
    const oldPosition = db.messages.get('thread-a:old')?.position;

    await saveThreadStateWith(db, 'thread-a', stateWith([
      { id: 'recent', kind: 'sulla', text: 'current answer updated' },
      { id: 'new', kind: 'user', text: 'next question' },
    ]) as any);

    expect(db.messages.has('thread-a:old')).toBe(true);
    expect(db.messages.get('thread-a:old')?.position).toBe(oldPosition);
    expect(db.messages.get('thread-a:recent')?.payload).toMatchObject({ text: 'current answer updated' });
    expect(db.messages.has('thread-a:new')).toBe(true);
  });
});

describe('ConversationThreadStore older-page reads', () => {
  it('returns a bounded page before the anchor in ascending position order', async() => {
    // risk: data accuracy — scroll-up must show the exact immediately preceding transcript slice
    const seen: any[] = [];
    const db: Queryable = { query: async(text, params = []) => {
      seen.push({ text, params });
      if (text.includes('SELECT position')) return { rows: [{ position: 5 }] };
      if (text.includes('SELECT payload')) return { rows: [{ payload: { id: 'm4' } }, { payload: { id: 'm3' } }] };
      return { rows: [{ id: 'thread-a' }] };
    } };
    const { loadMessagesBeforeWith } = await import('./ConversationThreadStore');
    const rows = await loadMessagesBeforeWith(db, 'thread-a', 'm5', 2);
    expect(rows.map(row => row.id)).toEqual(['m3', 'm4']);
    const page = seen.find(q => q.text.includes('SELECT payload'));
    expect(page?.params[1]).toBe(5);
    expect(page?.params[2]).toBe(2);
  });
});

describe('ConversationThreadStore explicit message deletion', () => {
  it('soft-deletes only the requested durable ids', async() => {
    // risk: data accuracy — retry/regenerate must not resurrect discarded assistant turns
    const calls: Array<{ text: string; params: any[] }> = [];
    const db: Queryable = { query: async(text, params = []) => {
      calls.push({ text, params });
      if (text.includes('FROM conversation_history') && text.includes('LIMIT 1')) return { rows: [{ id: 'thread-a' }] };
      return { rows: [] };
    } };
    const { deleteMessagesWith } = await import('./ConversationThreadStore');
    await deleteMessagesWith(db, 'thread-a', ['answer-1']);
    const deletion = calls.find(call => call.text.includes('UPDATE conversation_messages'));
    expect(deletion?.params).toEqual(['thread-a', ['thread-a:answer-1']]);
  });
});

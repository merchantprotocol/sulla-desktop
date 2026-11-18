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

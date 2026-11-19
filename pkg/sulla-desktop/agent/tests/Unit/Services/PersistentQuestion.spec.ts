// SPDX-License-Identifier: GPL-2.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/agent/database/PostgresClient', () => ({ postgresClient: { query: vi.fn(() => Promise.resolve([])) } }));
vi.mock('@pkg/agent/services/WebSocketClientService', () => ({ getWebSocketClientService: () => ({ send: () => Promise.resolve(true) }) }));

import { DecisionService } from '@pkg/agent/services/DecisionService';

const input = { conversationId: 'thread-a', channel: 'sulla-desktop', title: 'Choose a scope', questions: [{ question: 'Which scope?', options: [{ label: 'A' }, { label: 'B' }] }] };
function fixture() {
  const records: any[] = [];
  const pending = {
    ancestry: vi.fn(() => Promise.resolve(['thread-a'])),
    findOpenQuestion: vi.fn(async(value: any) => {
      await Promise.resolve();
      return records.find(record => record.conversationId === value.conversationId && record.channel === value.channel && record.title === value.title && JSON.stringify(record.questions) === JSON.stringify(value.questions) && record.attention !== 'dismissed' && (record.attention === 'active' || ['queued', 'processing'].includes(record.answerDelivery)));
    }),
    findById: vi.fn((id: string) => Promise.resolve(records.find(record => record.id === id))),
  };
  const decisions = { insert: vi.fn(async(record: any) => { await Promise.resolve(); records.push(structuredClone(record)) }) };
  const late = { handle: vi.fn(() => Promise.resolve({ settled: true, late: true, conversationId: 'thread-a' })) };
  const make = () => new DecisionService(late as any, { decisions, pendingDecisions: pending } as any);
  return { records, pending, decisions, late, make, service: make() };
}
beforeEach(() => vi.useRealTimers());
describe('persistent questions', () => {
  it('returns a durable receipt without an execution waiter or expiring timer', async() => {
    const f = fixture(); const stop = new AbortController();
    const receipt = await f.service.requestQuestion(input, stop.signal);
    expect(receipt.record).toMatchObject({ kind: 'question', status: 'pending', attention: 'active', payload: { answerRoute: 'inbox' } });
    expect((f.service as any).waiting.size).toBe(0);
    stop.abort();
    expect(f.records[0].attention).toBe('active');
    const afterRestart = await f.make().requestQuestion(input);
    expect(afterRestart.record.id).toBe(receipt.record.id);
    expect(afterRestart.reused).toBe(true);
    expect(f.decisions.insert).toHaveBeenCalledOnce();
  });
  it('serializes concurrent exact repeats into one card', async() => {
    const f = fixture();
    const receipts = await Promise.all(Array.from({ length: 10 }, () => f.service.requestQuestion(input)));
    expect(new Set(receipts.map(receipt => receipt.record.id)).size).toBe(1);
    expect(f.decisions.insert).toHaveBeenCalledOnce();
  });
  it('keeps different questions and conversations separate and allows an intentionally fresh answered question', async() => {
    const f = fixture();
    await f.service.requestQuestion(input);
    await f.service.requestQuestion({ ...input, conversationId: 'thread-b' });
    await f.service.requestQuestion({ ...input, questions: [{ question: 'A different scope?', options: [{ label: 'A' }] }] });
    f.records[0].attention = 'answered'; f.records[0].answerDelivery = 'delivered';
    await f.service.requestQuestion(input);
    expect(f.records).toHaveLength(4);
  });
  it('reuses a saved answer awaiting delivery instead of asking for it again', async() => {
    const f = fixture(); const first = await f.service.requestQuestion(input);
    Object.assign(f.records[0], { attention: 'answered', answerDelivery: 'queued', answers: [{ question: 'Which scope?', selected: ['A'] }] });
    expect((await f.service.requestQuestion(input)).record.id).toBe(first.record.id);
    expect(f.decisions.insert).toHaveBeenCalledOnce();
  });
  it('routes the answer through the durable delivery path even without a live waiter', async() => {
    const f = fixture(); const first = await f.service.requestQuestion(input);
    expect(await f.service.resolve({ id: first.record.id, conversationId: 'thread-a', action: 'answered', answers: [{ question: 'Which scope?', selected: ['A'] }] })).toMatchObject({ settled: true, late: true });
    expect(f.late.handle).toHaveBeenCalledOnce();
  });
  it('does not create a question for an already-cancelled request', async() => {
    const f = fixture(); const stop = new AbortController(); stop.abort();
    await expect(f.service.requestQuestion(input, stop.signal)).rejects.toThrow('cancelled');
    expect(f.decisions.insert).not.toHaveBeenCalled();
  });
});

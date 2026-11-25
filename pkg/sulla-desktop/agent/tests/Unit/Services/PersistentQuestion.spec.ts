// SPDX-License-Identifier: GPL-2.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/agent/database/PostgresClient', () => ({ postgresClient: { query: vi.fn(() => Promise.resolve([])) } }));
vi.mock('@pkg/agent/services/WebSocketClientService', () => ({ getWebSocketClientService: () => ({ send: () => Promise.resolve(true) }) }));

import { DecisionService } from '@pkg/agent/services/DecisionService';
import { DecisionAskerWaiter } from '@pkg/agent/services/DecisionAskerWaiter';
import { LateDecisionAnswerHandler } from '@pkg/agent/services/LateDecisionAnswerHandler';

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
    taskForThread: vi.fn(async(_threadId: string): Promise<any> => null),
  };
  const decisions = { insert: vi.fn(async(record: any) => { await Promise.resolve(); records.push(structuredClone(record)) }) };
  const late = { handle: vi.fn(() => Promise.resolve({ settled: true, late: true, conversationId: 'thread-a' })) };
  const make = (askerWaiter?: DecisionAskerWaiter) => new DecisionService(late as any, { decisions, pendingDecisions: pending, askerWaiter } as any);
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
    expect(await f.service.resolve({ id: first.record.id, conversationId: 'thread-a', action: 'answered', answers: [{ question: 'Which scope?', selected: ['A'] }] }, { kind: 'human' })).toMatchObject({ settled: true, late: true });
    expect(f.late.handle).toHaveBeenCalledOnce();
  });
  it('parks a delegated asker on a durable wait tied to its decision id', async() => {
    const f = fixture(); const park = vi.fn(async(..._args: any[]) => undefined);
    f.pending.taskForThread.mockImplementation(async(threadId: string) => threadId === 'thread-a' ? {
      jobId: 'job-1', taskIndex: 2, jobStatus: 'running', taskStatus: 'running', threadId: 'thread-a', parentThreadId: 'root', parentChannel: 'sulla-desktop',
    } : null);
    const service = f.make(new DecisionAskerWaiter({ park } as any));
    const receipt = await service.requestQuestion(input);
    expect(receipt.parked).toBe(true);
    expect(receipt.record.route).toMatchObject({ authority: 'any', holderIndex: 0, chain: [{ kind: 'human' }] });
    expect(f.pending.findById).not.toHaveBeenCalled();
    expect(receipt.record.payload).toMatchObject({ askerJobId: 'job-1', askerTaskIndex: '2' });
    expect(park).toHaveBeenCalledOnce();
    expect(park.mock.calls[0][0]).toBe('job-1');
    expect(park.mock.calls[0][1]).toBe(2);
    expect(park.mock.calls[0][2].reason).toContain(receipt.record.id);
  });
  it('wakes a parked ask_user_question task through its durable job mailbox after an answer', async() => {
    const f = fixture(); let taskStatus = 'running'; let waitReason = '';
    f.pending.taskForThread.mockImplementation(async(threadId: string) => threadId === 'thread-a' ? {
      jobId: 'job-1', taskIndex: 2, jobStatus: taskStatus, taskStatus, threadId: 'thread-a', parentThreadId: 'root', parentChannel: 'sulla-desktop',
    } : null);
    const parking = vi.fn(async(_jobId: string, _taskIndex: number, request: { reason: string }) => { waitReason = request.reason; taskStatus = 'parked' });
    const jobMessages = { send: vi.fn(async() => true) };
    const repository = {
      ...f.pending,
      recordJobAnswer: vi.fn(async(record: any, answers: any[]) => {
        const stored = f.records.find(item => item.id === record.id)!;
        Object.assign(stored, { status: 'answered', attention: 'answered', answerDelivery: 'queued', answers, answeredBy: record.answeredBy });
        return stored;
      }),
      markJobAnswerDelivered: vi.fn(async() => true),
      markJobAnswerUnavailable: vi.fn(async() => undefined),
    };
    const handler = new LateDecisionAnswerHandler(repository as any, { find: vi.fn() }, { send: vi.fn() }, jobMessages);
    const service = new DecisionService(handler, { decisions: f.decisions as any, pendingDecisions: repository as any,
      askerWaiter: new DecisionAskerWaiter({ park: parking } as any) });
    const request = await service.requestQuestion(input);

    expect(request.record.route).toMatchObject({ authority: 'any', holderIndex: 0, chain: [{ kind: 'human' }] });
    expect(waitReason).toContain(request.record.id);
    await expect(service.resolveAs({ kind: 'human' }, { id: request.record.id, conversationId: 'thread-a', action: 'answered', answers: [{ question: 'Which scope?', selected: ['A'] }] }))
      .resolves.toMatchObject({ settled: true, reason: 'Answer queued in the delegated task mailbox.' });
    expect(repository.recordJobAnswer).toHaveBeenCalledOnce();
    expect(jobMessages.send).toHaveBeenCalledWith('job-1', 2, '[Decision answered by your human]\nChoose a scope\nWhich scope?: A');
    expect(repository.markJobAnswerDelivered).toHaveBeenCalledWith(request.record.id);
  });
  it('keeps a saved question and emits changes when parking fails for new and reused asks', async() => {
    // risk: user communication — a task ending between question persistence and parking must not lose the saved question or its UI update.
    const f = fixture();
    f.pending.taskForThread.mockResolvedValue({
      jobId: 'job-1', taskIndex: 2, jobStatus: 'running', taskStatus: 'running', threadId: 'thread-a', parentThreadId: 'root', parentChannel: 'sulla-desktop',
    } as any);
    const park = vi.fn(async() => { throw new Error('task already ended') });
    const service = f.make(new DecisionAskerWaiter({ park } as any));
    const changed: any[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    service.subscribe(record => changed.push(record));
    try {
      const first = await service.requestQuestion(input);
      const reused = await service.requestQuestion(input);
      expect(first).toMatchObject({ reused: false });
      expect(first.parked).toBeUndefined();
      expect(reused).toMatchObject({ reused: true, record: { id: first.record.id } });
      expect(reused.parked).toBeUndefined();
      expect(changed.map(record => record.id)).toEqual([first.record.id, first.record.id]);
      expect(park).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally { warn.mockRestore() }
  });
  it('does not create a question for an already-cancelled request', async() => {
    const f = fixture(); const stop = new AbortController(); stop.abort();
    await expect(f.service.requestQuestion(input, stop.signal)).rejects.toThrow('cancelled');
    expect(f.decisions.insert).not.toHaveBeenCalled();
  });
});

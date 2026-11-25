// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { LateDecisionAnswerHandler } from '../../../services/LateDecisionAnswerHandler';
import type { DecisionRecord } from '@pkg/shared/decisions';
const record: DecisionRecord = { id: 'question-1', conversationId: 'thread-1', channel: 'sulla-desktop', title: 'Pick a color', kind: 'question', status: 'expired', attention: 'active', createdAt: 1, expiresAt: 2, questions: [{ question: 'Color?', options: [{ label: 'Blue' }] }] };
const response = { id: record.id, conversationId: record.conversationId, action: 'answered' as const, answers: [{ question: 'Color?', selected: ['Blue'] }] };
function fixture() {
  const decisions = { queueLateAnswer: vi.fn().mockResolvedValue({ ...record, attention: 'answered', answerDelivery: 'queued' }), findById: vi.fn(), markJobAnswerDelivered: vi.fn().mockResolvedValue(true) };
  const send = vi.fn().mockResolvedValue(true); const conversations = { find: vi.fn().mockResolvedValue({ id: 'thread-1' }) };
  return { decisions, send, conversations, handler: new LateDecisionAnswerHandler(decisions, conversations, { send }) };
}
describe('durable late answers', () => {
  it('queues the original decision and answers before signalling the original channel', async() => {
    const f = fixture(); await expect(f.handler.handle(record, response)).resolves.toMatchObject({ settled: true, late: true, reason: expect.stringContaining('queued') });
    expect(f.decisions.queueLateAnswer).toHaveBeenCalledWith(record, response.answers, 'My answers to your earlier question "Pick a color": Color?: Blue');
    expect(f.send).toHaveBeenCalledExactlyOnceWith('sulla-desktop', { type: 'decision_answer_queued', data: { decisionId: 'question-1' } });
    expect(f.decisions.queueLateAnswer.mock.invocationCallOrder[0]).toBeLessThan(f.send.mock.invocationCallOrder[0]);
  });
  it('uses a named decision envelope for an agent answering a chat asker', async() => {
    const f = fixture();
    const answered = { ...record, answeredBy: { kind: 'agent' as const, agentId: 'worker', label: 'Jonathon' } };
    await f.handler.handle(answered, response);
    expect(f.decisions.queueLateAnswer).toHaveBeenCalledWith(answered, response.answers, '[Decision answered by agent Jonathon]\nPick a color\nColor?: Blue');
  });
  it('keeps a committed answer queued if the wake connection fails', async() => {
    const f = fixture(); f.send.mockRejectedValue(new Error('bus unavailable'));
    await expect(f.handler.handle(record, response)).resolves.toMatchObject({ settled: true, reason: expect.stringContaining('queued') });
    expect(f.decisions.queueLateAnswer).toHaveBeenCalledTimes(1);
  });
  it('does not send a second wake or replace the answer when the same receipt already exists', async() => {
    const f = fixture(); f.decisions.queueLateAnswer.mockResolvedValue(undefined); f.decisions.findById.mockResolvedValue({ ...record, attention: 'answered', answerDelivery: 'queued', answeredBy: { kind: 'human' }, answers: response.answers });
    await expect(f.handler.handle(record, response)).resolves.toMatchObject({ settled: true }); expect(f.send).not.toHaveBeenCalled();
  });
  it('does not report a conflicting or dismissed request as answered', async() => {
    const f = fixture(); f.decisions.queueLateAnswer.mockResolvedValue(undefined); f.decisions.findById.mockResolvedValue({ ...record, attention: 'dismissed' });
    await expect(f.handler.handle(record, response)).resolves.toMatchObject({ settled: false }); expect(f.send).not.toHaveBeenCalled();
  });
  it('rejects a competing answer after another actor won the compare-and-set', async() => {
    // risk: concurrency — a later parent answer must not report success after the human already answered this question.
    const f = fixture();
    const attempt = { ...record, answeredBy: { kind: 'agent' as const, agentId: 'parent', threadId: 'parent-thread' } };
    f.decisions.queueLateAnswer.mockResolvedValue(undefined);
    f.decisions.findById.mockResolvedValue({ ...record, attention: 'answered', answerDelivery: 'queued', answeredBy: { kind: 'human' }, answers: [{ question: 'Color?', selected: ['Red'] }] });

    await expect(f.handler.handle(attempt, response)).resolves.toMatchObject({ settled: false, reason: expect.stringContaining('changed') });
    expect(f.send).not.toHaveBeenCalled();
  });
  it('treats an identical same-agent retry as idempotent', async() => {
    // risk: user communication — retrying an already-committed parent answer does not create a duplicate inbox message.
    const f = fixture();
    const attempt = { ...record, answeredBy: { kind: 'agent' as const, agentId: 'parent', threadId: 'parent-thread' } };
    f.decisions.queueLateAnswer.mockResolvedValue(undefined);
    f.decisions.findById.mockResolvedValue({ ...attempt, attention: 'answered', answerDelivery: 'queued', answers: response.answers });

    await expect(f.handler.handle(attempt, response)).resolves.toMatchObject({ settled: true });
    expect(f.send).not.toHaveBeenCalled();
  });
  it('does not queue into a deleted or replacement conversation', async() => {
    const f = fixture(); f.conversations.find.mockResolvedValue(null);
    await expect(f.handler.handle(record, response)).resolves.toMatchObject({ closed: true }); expect(f.decisions.queueLateAnswer).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it('propagates a durable-store failure without a false send receipt', async() => {
    const f = fixture(); f.decisions.queueLateAnswer.mockRejectedValue(new Error('store unavailable'));
    await expect(f.handler.handle(record, response)).rejects.toThrow('store unavailable'); expect(f.send).not.toHaveBeenCalled();
  });
  it('records and sends a delegated answer through the job mailbox with the answerer named', async() => {
    const delegated = { ...record, payload: { askerJobId: 'job-1', askerTaskIndex: '2' }, answeredBy: { kind: 'agent' as const, agentId: 'coding-manager', label: 'Coding Manager' } };
    const decisions = {
      recordJobAnswer: vi.fn(async() => ({ ...delegated, status: 'answered' as const, answerDelivery: 'queued' as const })),
      findById: vi.fn(),
      taskForThread: vi.fn(async() => ({ jobId: 'job-1', taskIndex: 2, jobStatus: 'running', taskStatus: 'parked' })),
      markJobAnswerDelivered: vi.fn(async() => true),
    };
    const jobMessages = { send: vi.fn(async() => true) };
    const sender = { send: vi.fn(async() => true) };
    const handler = new LateDecisionAnswerHandler(decisions as any, { find: vi.fn() }, sender, jobMessages);

    await expect(handler.handle(delegated, response)).resolves.toMatchObject({ settled: true, reason: 'Answer queued in the delegated task mailbox.' });
    expect(decisions.recordJobAnswer).toHaveBeenCalledWith(delegated, response.answers);
    expect(jobMessages.send).toHaveBeenCalledWith('job-1', 2, '[Decision answered by agent Coding Manager]\nPick a color\nColor?: Blue');
    expect(decisions.markJobAnswerDelivered).toHaveBeenCalledExactlyOnceWith(record.id);
    expect(jobMessages.send.mock.invocationCallOrder[0]).toBeLessThan(decisions.markJobAnswerDelivered.mock.invocationCallOrder[0]);
    expect(sender.send).not.toHaveBeenCalled();
  });
  it('keeps a finished or stopped asker answer recorded and reports that it could not be woken', async() => {
    const delegated = { ...record, payload: { askerJobId: 'job-1', askerTaskIndex: '2' }, answeredBy: { kind: 'human' as const } };
    const decisions = {
      recordJobAnswer: vi.fn(async() => ({ ...delegated, status: 'answered' as const, answerDelivery: 'queued' as const })),
      findById: vi.fn(), taskForThread: vi.fn(async() => ({ jobId: 'job-1', taskIndex: 2, jobStatus: 'stopped', taskStatus: 'stopped' })),
      markJobAnswerUnavailable: vi.fn(async() => undefined),
    };
    const jobMessages = { send: vi.fn(async() => true) };
    const handler = new LateDecisionAnswerHandler(decisions as any, { find: vi.fn() }, { send: vi.fn() }, jobMessages);

    await expect(handler.handle(delegated, response)).resolves.toMatchObject({ settled: true, reason: expect.stringContaining('finished or stopped') });
    expect(decisions.recordJobAnswer).toHaveBeenCalledOnce();
    expect(decisions.markJobAnswerUnavailable).toHaveBeenCalledWith(record.id);
    expect(jobMessages.send).not.toHaveBeenCalled();
  });
});

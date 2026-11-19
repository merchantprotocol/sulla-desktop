// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { LateDecisionAnswerHandler } from '../../../services/LateDecisionAnswerHandler';
import type { DecisionRecord } from '@pkg/shared/decisions';
const record: DecisionRecord = { id: 'question-1', conversationId: 'thread-1', channel: 'sulla-desktop', title: 'Pick a color', kind: 'question', status: 'expired', attention: 'active', createdAt: 1, expiresAt: 2, questions: [{ question: 'Color?', options: [{ label: 'Blue' }] }] };
const response = { id: record.id, conversationId: record.conversationId, action: 'answered' as const, answers: [{ question: 'Color?', selected: ['Blue'] }] };
function fixture() {
  const decisions = { queueLateAnswer: vi.fn().mockResolvedValue({ ...record, attention: 'answered', answerDelivery: 'queued' }), findById: vi.fn() };
  const send = vi.fn().mockResolvedValue(true); const conversations = { find: vi.fn().mockResolvedValue({ id: 'thread-1' }) };
  return { decisions, send, conversations, handler: new LateDecisionAnswerHandler(decisions, conversations, { send }) };
}
describe('durable late answers', () => {
  it('queues the original decision and answers before signalling the original channel', async() => {
    const f = fixture(); await expect(f.handler.handle(record, response)).resolves.toMatchObject({ settled: true, late: true, reason: expect.stringContaining('queued') });
    expect(f.decisions.queueLateAnswer).toHaveBeenCalledWith(record, response.answers, expect.stringContaining('Color?: Blue'));
    expect(f.send).toHaveBeenCalledExactlyOnceWith('sulla-desktop', { type: 'decision_answer_queued', data: { decisionId: 'question-1' } });
    expect(f.decisions.queueLateAnswer.mock.invocationCallOrder[0]).toBeLessThan(f.send.mock.invocationCallOrder[0]);
  });
  it('keeps a committed answer queued if the wake connection fails', async() => {
    const f = fixture(); f.send.mockRejectedValue(new Error('bus unavailable'));
    await expect(f.handler.handle(record, response)).resolves.toMatchObject({ settled: true, reason: expect.stringContaining('queued') });
    expect(f.decisions.queueLateAnswer).toHaveBeenCalledTimes(1);
  });
  it('does not send a second wake or replace the answer when the same receipt already exists', async() => {
    const f = fixture(); f.decisions.queueLateAnswer.mockResolvedValue(undefined); f.decisions.findById.mockResolvedValue({ ...record, answerDelivery: 'queued' });
    await expect(f.handler.handle(record, response)).resolves.toMatchObject({ settled: true }); expect(f.send).not.toHaveBeenCalled();
  });
  it('does not report a conflicting or dismissed request as answered', async() => {
    const f = fixture(); f.decisions.queueLateAnswer.mockResolvedValue(undefined); f.decisions.findById.mockResolvedValue({ ...record, attention: 'dismissed' });
    await expect(f.handler.handle(record, response)).resolves.toMatchObject({ settled: false }); expect(f.send).not.toHaveBeenCalled();
  });
  it('does not queue into a deleted or replacement conversation', async() => {
    const f = fixture(); f.conversations.find.mockResolvedValue(null);
    await expect(f.handler.handle(record, response)).resolves.toMatchObject({ closed: true }); expect(f.decisions.queueLateAnswer).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it('propagates a durable-store failure without a false send receipt', async() => {
    const f = fixture(); f.decisions.queueLateAnswer.mockRejectedValue(new Error('store unavailable'));
    await expect(f.handler.handle(record, response)).rejects.toThrow('store unavailable'); expect(f.send).not.toHaveBeenCalled();
  });
});

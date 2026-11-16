// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';
import { LateDecisionAnswerHandler } from '../../../services/LateDecisionAnswerHandler';
import type { DecisionRecord } from '@pkg/shared/decisions';

const record: DecisionRecord = {
  id: 'question-1', conversationId: 'thread-1', channel: 'sulla-desktop', title: 'Pick a color',
  kind: 'question', status: 'expired', createdAt: 1, expiresAt: 2,
  questions: [{ question: 'Color?', options: [{ label: 'Blue' }] }],
};
const response = { id: record.id, conversationId: record.conversationId, action: 'answered' as const, answers: [{ question: 'Color?', selected: ['Blue'] }] };

const repo = (claimed = true) => ({ claimLateAnswer: vi.fn().mockResolvedValue(claimed), releaseLateAnswer: vi.fn().mockResolvedValue(undefined) });
const thread = { find: vi.fn().mockResolvedValue({ id: 'thread-1' }) };

describe('LateDecisionAnswerHandler', () => {
  // risk: user communication. A late answer used to post only a notice, so Sulla never acted on it.
  it('hands a late answer to Sulla once, without replacing a running turn, and saves it', async() => {
    const decisions = repo();
    const send = vi.fn().mockResolvedValue(true);
    const handler = new LateDecisionAnswerHandler(decisions, thread, { send });

    await expect(handler.handle(record, response)).resolves.toMatchObject({ settled: true, late: true });

    expect(decisions.claimLateAnswer).toHaveBeenCalledWith('question-1', [{ question: 'Color?', selected: ['Blue'] }]);
    // inject_message steers a live turn, or starts one when the thread is idle; a user_message would replace a running turn.
    expect(send.mock.calls[0]).toEqual(['sulla-desktop', expect.objectContaining({
      type: 'inject_message',
      data: expect.objectContaining({ threadId: 'thread-1', content: expect.stringContaining('Color?: Blue'), metadata: expect.objectContaining({ decisionId: 'question-1' }) }),
    })]);
    expect(send.mock.calls[1][1]).toMatchObject({ type: 'assistant_message', data: { kind: 'notice', thread_id: 'thread-1' } });
  });

  // risk: data loss. The claim was taken before sending and a failed send was ignored.
  it('releases the claim and reports failure when Sulla cannot be reached', async() => {
    for (const send of [vi.fn().mockResolvedValue(false), vi.fn().mockRejectedValue(new Error('bus down'))]) {
      const decisions = repo();
      const handler = new LateDecisionAnswerHandler(decisions, thread, { send });

      await expect(handler.handle(record, response)).resolves.toMatchObject({ settled: false, reason: expect.stringContaining('send them again') });
      expect(decisions.releaseLateAnswer).toHaveBeenCalledWith('question-1');
      expect(send).toHaveBeenCalledTimes(1);
    }
  });

  it('closes the card when the original thread is gone', async() => {
    // risk: data correctness — never emit a late answer into a replacement or unrelated thread.
    const decisions = repo();
    const send = vi.fn();
    const handler = new LateDecisionAnswerHandler(decisions, { find: vi.fn().mockResolvedValue(null) }, { send });
    await expect(handler.handle(record, response)).resolves.toMatchObject({ settled: true, late: true, closed: true });
    expect(decisions.claimLateAnswer).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not send a duplicate when another click already claimed delivery', async() => {
    // risk: duplicate messaging — double-clicks must produce at most one delivery.
    const send = vi.fn();
    const handler = new LateDecisionAnswerHandler(repo(false), thread, { send });
    await expect(handler.handle(record, response)).resolves.toMatchObject({ settled: true, late: true });
    expect(send).not.toHaveBeenCalled();
  });
});

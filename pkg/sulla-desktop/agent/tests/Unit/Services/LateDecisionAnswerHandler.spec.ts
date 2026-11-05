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

describe('LateDecisionAnswerHandler', () => {
  it('delivers a late answer once as a new message', async() => {
    // risk: user communication — a timeout answer must not be silently lost or duplicated.
    const claim = vi.fn().mockResolvedValue(true);
    const send = vi.fn().mockResolvedValue(true);
    const handler = new LateDecisionAnswerHandler({ claimLateAnswer: claim }, { find: vi.fn().mockResolvedValue({ id: 'thread-1' }) }, { send });
    await expect(handler.handle(record, response)).resolves.toMatchObject({ settled: true, late: true, reason: 'answered late — sent as a new message' });
    expect(claim).toHaveBeenCalledWith('question-1');
    expect(send).toHaveBeenCalledWith('sulla-desktop', expect.objectContaining({ data: expect.objectContaining({ content: 'Late answer to Pick a color: Color?: Blue', thread_id: 'thread-1' }) }));
  });

  it('closes the card when the original thread is gone', async() => {
    // risk: data correctness — never emit a late answer into a replacement or unrelated thread.
    const claim = vi.fn();
    const send = vi.fn();
    const handler = new LateDecisionAnswerHandler({ claimLateAnswer: claim }, { find: vi.fn().mockResolvedValue(null) }, { send });
    await expect(handler.handle(record, response)).resolves.toMatchObject({ settled: true, late: true, closed: true });
    expect(claim).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not send a duplicate when another click already claimed delivery', async() => {
    // risk: duplicate messaging — double-clicks must produce at most one new message.
    const send = vi.fn();
    const handler = new LateDecisionAnswerHandler({ claimLateAnswer: vi.fn().mockResolvedValue(false) }, { find: vi.fn().mockResolvedValue({ id: 'thread-1' }) }, { send });
    await expect(handler.handle(record, response)).resolves.toMatchObject({ settled: true, late: true });
    expect(send).not.toHaveBeenCalled();
  });
});

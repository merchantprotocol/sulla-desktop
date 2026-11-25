// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { DecisionService } from '../../../services/DecisionService';
import type { DecisionRouteEntry, DecisionRecord } from '@pkg/shared/decisions';

const chain: DecisionRouteEntry[] = [
  { threadId: 'parent-thread', channel: 'parent-channel', agentId: 'manager', jobId: 'job-1', taskIndex: 0, kind: 'agent' },
  { threadId: 'root-thread', channel: 'root-channel', agentId: 'human', kind: 'human' },
];

describe('decision route creation', () => {
  it('routes only agent-held questions and leaves approvals and chat questions on the legacy settle path', async() => {
    // risk: authorization — only plain questions with an agent ancestor may leave the legacy human decision path.
    const stored: DecisionRecord[] = [];
    const pending = {
      ancestry: vi.fn(async() => ['asker-thread', 'root-thread']),
      taskForThread: vi.fn(async() => null),
      findOpenQuestion: vi.fn(async() => undefined),
      findById: vi.fn(async(id: string) => stored.find(record => record.id === id)),
    };
    const decisions = {
      insert: vi.fn(async(record: DecisionRecord) => { stored.push(record) }),
      settle: vi.fn(async(id: string, status: string, record: DecisionRecord) => {
        const index = stored.findIndex(existing => existing.id === id);
        if (index < 0) return false;
        stored[index] = record;
        return status === record.status;
      }),
    };
    const routeResolver = { resolve: vi.fn(async(conversationId: string) => conversationId === 'chat-thread'
      ? [{ threadId: 'chat-thread', channel: 'chat-channel', agentId: 'human', kind: 'human' as const }]
      : chain) };
    const escalation = {
      start: vi.fn(async() => undefined), reconcile: vi.fn(async() => undefined), answerAsAgent: vi.fn(),
      authorize: vi.fn(async() => true), passFromResolveAs: vi.fn(async() => true), historyForAction: vi.fn(() => []),
    };
    const parentFyiNotifier = { notify: vi.fn(async() => undefined) };
    const service = new DecisionService(undefined, { pendingDecisions: pending as any, decisions: decisions as any, routeResolver: routeResolver as any, escalation: escalation as any, parentFyiNotifier: parentFyiNotifier as any });
    const approval = await service.request({ kind: 'approval', conversationId: 'asker-thread', channel: 'child-channel', title: 'Approve?' });
    const plain = await service.requestQuestion({
      conversationId: 'asker-thread', channel: 'child-channel', title: 'Choose?', questions: [{ question: 'Which?', options: [{ label: 'A' }] }],
    });
    const task = await service.requestQuestion({
      conversationId: 'asker-thread', channel: 'child-channel', title: 'Do this?', questions: [{ question: 'Run this on the Mac?', task: true, options: [{ label: 'Done' }] }],
    });
    const chatQuestion = await service.requestQuestion({
      conversationId: 'chat-thread', channel: 'chat-channel', title: 'Choose here?', questions: [{ question: 'Which?', options: [{ label: 'A' }] }],
    });
    const consent = await service.request({
      kind: 'question', conversationId: 'asker-thread', channel: 'child-channel', title: 'First contact', payload: { decisionAuthority: 'human' },
    });

    expect(approval.record.route).toBeUndefined();
    expect(plain.record.route).toMatchObject({ authority: 'any', chain, holderIndex: 0, history: [] });
    expect(task.record.route).toBeUndefined();
    expect(chatQuestion.record.route).toBeUndefined();
    expect(consent.record.route).toBeUndefined();
    expect(parentFyiNotifier.notify.mock.calls.some(([record]) => record.kind === 'question' && !record.route)).toBe(true);
    expect(routeResolver.resolve).toHaveBeenCalledTimes(2);
    expect(escalation.start).toHaveBeenCalledOnce();

    const resultPromise = approval.result;
    await expect(service.resolve({ id: approval.record.id, conversationId: 'asker-thread', action: 'approved' }, { kind: 'human' })).resolves.toMatchObject({ settled: true });
    await expect(resultPromise).resolves.toMatchObject({ status: 'approved', answeredBy: { kind: 'human' } });
    expect(decisions.settle).toHaveBeenCalledWith(approval.record.id, 'approved', expect.objectContaining({ answeredBy: { kind: 'human' } }), expect.any(String));
    expect(decisions.settle.mock.calls[0][2]).not.toHaveProperty('route');
    expect(escalation.historyForAction).not.toHaveBeenCalled();
  });
});

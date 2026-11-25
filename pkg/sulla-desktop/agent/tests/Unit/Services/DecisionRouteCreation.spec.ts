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
  it('snapshots authority and the correct initial holder without changing settlement flow', async() => {
    // risk: authorization — task:true/consent decisions start with the human; ordinary questions start with their direct parent.
    const stored: DecisionRecord[] = [];
    const pending = {
      ancestry: vi.fn(async() => ['asker-thread', 'root-thread']),
      findOpenQuestion: vi.fn(async() => undefined),
    };
    const decisions = {
      insert: vi.fn(async(record: DecisionRecord) => { stored.push(record) }),
      settle: vi.fn(async() => true),
    };
    const routeResolver = { resolve: vi.fn(async() => chain) };
    const service = new DecisionService(undefined, { pendingDecisions: pending as any, decisions: decisions as any, routeResolver: routeResolver as any });
    const approval = await service.request({ kind: 'approval', conversationId: 'asker-thread', channel: 'child-channel', title: 'Approve?' });
    const plain = await service.requestQuestion({
      conversationId: 'asker-thread', channel: 'child-channel', title: 'Choose?', questions: [{ question: 'Which?', options: [{ label: 'A' }] }],
    });
    const task = await service.requestQuestion({
      conversationId: 'asker-thread', channel: 'child-channel', title: 'Do this?', questions: [{ question: 'Run this on the Mac?', task: true, options: [{ label: 'Done' }] }],
    });
    const consent = await service.request({
      kind: 'question', conversationId: 'asker-thread', channel: 'child-channel', title: 'First contact', payload: { decisionAuthority: 'human' },
    });

    expect(approval.record.route).toMatchObject({ authority: 'human', chain, holderIndex: 1, history: [] });
    expect(plain.record.route).toMatchObject({ authority: 'any', chain, holderIndex: 0, history: [] });
    expect(task.record.route).toMatchObject({ authority: 'human', holderIndex: 1 });
    expect(consent.record.route).toMatchObject({ authority: 'human', holderIndex: 1 });

    const resultPromise = approval.result;
    await expect(service.resolve({ id: approval.record.id, conversationId: 'asker-thread', action: 'approved' }, { kind: 'human' })).resolves.toMatchObject({ settled: true });
    await expect(resultPromise).resolves.toMatchObject({ status: 'approved', answeredBy: { kind: 'human' } });
    expect(decisions.settle).toHaveBeenCalledWith(approval.record.id, 'approved', expect.objectContaining({ answeredBy: { kind: 'human' } }), expect.any(String));
    expect(routeResolver.resolve).toHaveBeenCalledTimes(4);
  });
});

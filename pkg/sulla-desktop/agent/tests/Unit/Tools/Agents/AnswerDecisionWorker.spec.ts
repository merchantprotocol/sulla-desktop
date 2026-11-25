// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ answerAsAgent: vi.fn(async(..._args: unknown[]) => ({ settled: true })) }));
vi.mock('../../../../services/DecisionService', () => ({ decisionService: mocked }));
vi.mock('../../../../tools/toolDecisionPort', () => ({ toolDecisionPort: { resolve: () => ({ requiresApproval: async() => false }) } }));

import { AnswerDecisionWorker } from '../../../../tools/agents/answer_decision';

describe('AnswerDecisionWorker', () => {
  beforeEach(() => mocked.answerAsAgent.mockClear());

  it('rejects a sessionless call even when the cached tool state names a thread', async() => {
    // risk: authorization — a sessionless CLI caller must not inherit an earlier graph's cached thread identity.
    const worker = new AnswerDecisionWorker();
    worker.name = 'agents/answer_decision';
    worker.setState({ metadata: { threadId: 'stale-holder' } } as any);

    await expect(worker.call({ decisionId: 'd-1', action: 'answer' })).resolves.toMatchObject({
      success: false, error: 'agents/answer_decision requires a verified tool session.',
    });
    expect(mocked.answerAsAgent).not.toHaveBeenCalled();
  });

  it('uses only the per-call thread supplied by the verified tool session', async() => {
    // risk: identity integrity — caller identity comes from the authenticated session, never an input thread id or stale graph state.
    const worker = new AnswerDecisionWorker();
    worker.name = 'agents/answer_decision';
    await expect(worker.callWithVerifiedSession('verified-holder', { decisionId: 'd-2', action: 'pass', note: 'No context.' }))
      .resolves.toMatchObject({ success: true });
    expect(mocked.answerAsAgent).toHaveBeenCalledWith('verified-holder', 'd-2', 'pass', undefined, 'No context.');
    await expect(worker.call({ decisionId: 'd-2', action: 'answer' })).resolves.toMatchObject({
      success: false, error: 'agents/answer_decision requires a verified tool session.',
    });
  });

  it('keeps concurrent authenticated CLI calls bound to their own verified sessions', async() => {
    // risk: identity integrity — concurrent HTTP dispatches must never exchange the parent identities used for the decision CAS.
    const worker = new AnswerDecisionWorker();
    worker.name = 'agents/answer_decision';

    await Promise.all([
      worker.callWithVerifiedSession('verified-a', { decisionId: 'd-a', action: 'answer' }),
      worker.callWithVerifiedSession('verified-b', { decisionId: 'd-b', action: 'answer' }),
    ]);

    expect(mocked.answerAsAgent.mock.calls.map(([threadId]) => threadId).sort()).toEqual(['verified-a', 'verified-b']);
  });

  it('binds an in-process invocation to its current graph state rather than cached state', async() => {
    // risk: authorization — a live graph tool call uses its own trusted thread even when the reusable worker was previously bound elsewhere.
    const worker = new AnswerDecisionWorker();
    worker.name = 'agents/answer_decision';
    worker.setState({ metadata: { threadId: 'cached-holder' } } as any);

    await expect(worker.invoke({ decisionId: 'd-3', action: 'answer' }, { metadata: { threadId: 'current-holder' } } as any))
      .resolves.toMatchObject({ success: true });
    expect(mocked.answerAsAgent).toHaveBeenCalledWith('current-holder', 'd-3', 'answer', undefined, undefined);
  });

  it('keeps concurrent calls bound to their own graph threads', async() => {
    // risk: identity integrity — two agents sharing a cached worker cannot race and answer as each other.
    const worker = new AnswerDecisionWorker();
    worker.name = 'agents/answer_decision';
    await Promise.all([
      worker.invoke({ decisionId: 'd-a', action: 'answer' }, { metadata: { threadId: 'holder-a' } } as any),
      worker.invoke({ decisionId: 'd-b', action: 'answer' }, { metadata: { threadId: 'holder-b' } } as any),
    ]);

    expect(mocked.answerAsAgent.mock.calls.map(([threadId]) => threadId).sort()).toEqual(['holder-a', 'holder-b']);
  });
});

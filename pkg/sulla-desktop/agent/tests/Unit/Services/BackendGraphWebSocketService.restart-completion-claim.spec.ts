// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => 'test', isPackaged: false }, safeStorage: {} }));
vi.mock('@pkg/main/SleepPreventionService', () => ({ acquireChatActivity: vi.fn(), releaseChatActivity: vi.fn() }));
vi.mock('../../../services/ModelProviderService', () => ({
  getModelProviderService: () => ({ isInitialized: () => true, getPrimaryProvider: () => 'codex' }),
}));

afterEach(async() => {
  vi.restoreAllMocks();
  const { clearCompletionInboxes } = await import('../../../services/AgentCompletionInbox');
  clearCompletionInboxes();
});

describe('restart completion claim ownership', () => {
  it.each([
    ['generation mismatch', { generation: 1, status: 'running' }, 2, false],
    ['status mismatch', { generation: 2, status: 'parked' }, 2, false],
    ['pending decision', { generation: 2, status: 'running' }, 2, true],
  ])('leaves completions unclaimed when restart recovery is rejected for %s', async(_name, task, generation, pendingDecision) => {
    const channel = `restart-${ String(_name).replaceAll(' ', '-') }`;
    const threadId = `${ channel }-thread`;
    const { enqueueAgentCompletion, takeAgentCompletions } = await import('../../../services/AgentCompletionInbox');
    const completion = { jobId: `${ channel }-child`, taskIndex: 0, results: [] } as any;
    enqueueAgentCompletion(channel, threadId, completion);

    const { BackendGraphWebSocketService } = await import('../../../services/BackendGraphWebSocketService');
    const { parkedAgentRehydrator } = await import('../../../services/ParkedAgentRehydrator');
    vi.spyOn(await import('../../../services/GraphRegistry'), 'getAgentIdForTrigger').mockResolvedValue('builder');
    vi.spyOn(parkedAgentRehydrator, 'resolve').mockResolvedValue({
      job: { jobId: 'job-1' }, task: { ...task, returnedAt: undefined }, taskIndex: 3, agentId: 'builder',
    } as any);
    const service = Object.create(BackendGraphWebSocketService.prototype);
    Object.assign(service, {
      activeAborts:              new Map(),
      resumeContexts:            new Map(),
      recoveryAbort:             new AbortController(),
      deliveringDecisionThreads: new Set(),
      decisionThreadOwned:       () => false,
      hasPendingDecision:        vi.fn(() => Promise.resolve(pendingDecision)),
      wsService:                 { send: vi.fn() },
    });

    await expect(service.executeReadyTurn(channel, 'sulla-desktop', '', threadId, undefined, 'builder', 'system', {
      source: 'runtime_restart_recovery', delegatedJobId: 'job-1', delegatedTaskIndex: 3, generation,
    })).resolves.toBe('deferred');

    expect(takeAgentCompletions(channel, threadId)).toEqual([expect.objectContaining({ jobId: completion.jobId, taskIndex: 0 })]);
  });
});

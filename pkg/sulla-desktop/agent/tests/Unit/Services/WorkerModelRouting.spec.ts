// SPDX-License-Identifier: GPL-2.0-or-later
/* Async mocks mirror production interfaces without network or database effects. */
/* eslint-disable @typescript-eslint/require-await */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InfrastructureFailure } from '../../../languagemodels/providerRecovery';
import { saveThreadState } from '../../../nodes/ThreadStateStore';
import { detachTerminalWorkerChat, isWorkerMappingHumanTurn, installWorkerRoute, workerModelRouting } from '../../../services/WorkerModelRouting';

const fixture = vi.hoisted(() => ({ job: null as any, fail: false }));
vi.mock('../../../services/AgentDefinitionService', () => ({ agentDefinitionService: { findBySlug: vi.fn() } }));
vi.mock('../../../services/IntegrationService', () => ({ getIntegrationService: vi.fn() }));
vi.mock('../../../languagemodels/credentials/ClaudeCredentialResolver', () => ({ claudeCredentialResolver: { resolve: vi.fn() } }));
vi.mock('../../../languagemodels/modelRouter', () => ({ modelRouter: {} }));
vi.mock('../../../nodes/ThreadStateStore', () => ({ saveThreadState: vi.fn(() => Promise.resolve()) }));
vi.mock('../../../app/Providers/AgentJobServiceProvider', () => ({
  agentJobProvider: {
    states: {
      mutateJob: async(_id: string, mutate: any) => {
        if (fixture.fail) throw new Error('synthetic store unavailable');
        if (!fixture.job) return undefined;
        fixture.job = mutate(fixture.job); return fixture.job;
      },
    },
  },
}));
const a = { provider: 'codex', model: 'luna', effort: 'max' };
const b = { provider: 'claude-code', model: 'sonnet', effort: 'high' };
function state() {
  const value: any = { metadata: { threadId: 'child' } };
  installWorkerRoute(value, { version: 1, slug: 'luna', agentId: 'definition', revision: 3, selected: 0, candidates: [a, b] }, { jobId: 'job', taskIndex: 0, generation: 1 });
  fixture.job = { status: 'running', tasks: [{ status: 'running', generation: 1, threadId: 'child', workerModelRoute: structuredClone(value.metadata.workerModelRoute) }] };
  return value;
}
beforeEach(() => { fixture.fail = false; vi.mocked(saveThreadState).mockReset().mockResolvedValue(undefined) });
describe('durable worker model selection', () => {
  it('saves the fallback in task and thread before returning to provider invocation', async() => {
    const run = state(); await workerModelRouting.persistSelection(run, b);
    expect(fixture.job.tasks[0].workerModelRoute.selected).toBe(1);
    expect(run.metadata.workerModelRoute.selected).toBe(1);
    expect(saveThreadState).toHaveBeenCalledWith(run);
  });
  it.each(['stopped', 'completed', 'lost', 'error'])('refuses %s tasks without reopening work', async(status) => {
    const run = state(); fixture.job.tasks[0].status = status;
    await expect(workerModelRouting.persistSelection(run, b)).rejects.toBeInstanceOf(InfrastructureFailure);
    expect(fixture.job.tasks[0].status).toBe(status); expect(saveThreadState).not.toHaveBeenCalled();
  });
  it('refuses stale thread, generation and backwards fallback writes', async() => {
    for (const patch of [{ threadId: 'other' }, { generation: 2 }, { workerModelRoute: { ...state().metadata.workerModelRoute, selected: 1 } }]) {
      const run = state(); Object.assign(fixture.job.tasks[0], patch);
      await expect(workerModelRouting.persistSelection(run, a)).rejects.toBeInstanceOf(InfrastructureFailure);
    }
  });
  it('fails closed for missing jobs, failed durable writes and failed thread snapshots', async() => {
    const run = state(); fixture.job = null;
    await expect(workerModelRouting.persistSelection(run, b)).rejects.toBeInstanceOf(InfrastructureFailure);
    state(); fixture.fail = true;
    await expect(workerModelRouting.persistSelection(run, b)).rejects.toBeInstanceOf(InfrastructureFailure);
    fixture.fail = false; state(); vi.mocked(saveThreadState).mockRejectedValue(new Error('synthetic thread store down'));
    await expect(workerModelRouting.persistSelection(run, b)).rejects.toBeInstanceOf(InfrastructureFailure);
  });
  it('does not apply a worker selection over a trusted chat-picker exception', async() => {
    const run = state(); run.metadata.workerModelChatOverride = true;
    await workerModelRouting.persistSelection(run, b);
    expect(fixture.job.tasks[0].workerModelRoute.selected).toBe(0); expect(saveThreadState).not.toHaveBeenCalled();
  });
  it('detaches a terminal human follow-up without changing durable work, workspace or permissions', () => {
    const run = state(); const job = structuredClone(fixture.job);
    Object.assign(run.metadata, { delegatedJobId: 'job', managerThreadId: 'parent', activityKeys: ['ancestor'], modelDecisionTask: { jobId: 'job', taskIndex: 0 }, modelDecision: { requested: null, ran: null, step: 'category' }, modelOverride: { provider: 'grok', model: 'grok-4.6' }, isSubAgent: true, containerPersistenceKey: 'workspace', agent: { provider: 'codex', model: 'old', effort: 'max' } });
    detachTerminalWorkerChat(run);
    expect(fixture.job).toEqual(job);
    expect(run.metadata).toMatchObject({ isSubAgent: true, containerPersistenceKey: 'workspace', agent: {} });
    expect(run.metadata.workerModelTask).toBeUndefined(); expect(run.metadata.activityKeys).toBeUndefined();
    expect(run.metadata.modelDecisionTask).toBeUndefined(); expect(run.metadata.modelDecision).toBeUndefined(); expect(run.metadata.modelOverride).toBeUndefined();
    run.metadata.workerModelChatOverride = true; run.metadata.agent = { model: 'human-pin' };
    detachTerminalWorkerChat(run); expect(run.metadata.agent.model).toBe('human-pin');
  });
  it('reserves new selection boundaries for human messages, not scheduled or workflow continuations', () => {
    expect(isWorkerMappingHumanTurn('user_message', 'luna', {})).toBe(true);
    for (const origin of ['scheduler', 'workflow_continuation']) expect(isWorkerMappingHumanTurn('user_message', 'luna', { origin })).toBe(false);
    expect(isWorkerMappingHumanTurn('user_message', 'heartbeat', {})).toBe(false);
    expect(isWorkerMappingHumanTurn('user_message', 'luna', { inputSource: 'system' })).toBe(false);
    expect(isWorkerMappingHumanTurn('inject_message', 'luna', {})).toBe(false);
  });
  it('leaves an unbound hidden launch on its legacy pin without mapping ownership metadata', () => {
    const run: any = { metadata: { agent: { model: 'legacy-pin', effort: 'high' }, delegatedJobId: 'legacy-job' } };
    installWorkerRoute(run, undefined, { jobId: 'legacy-job', taskIndex: 0 });
    expect(run.metadata.workerModelTask).toBeUndefined(); expect(run.metadata.workerModelRoute).toBeUndefined();
    expect(run.metadata.agent).toEqual({ model: 'legacy-pin', effort: 'high' }); expect(run.metadata.delegatedJobId).toBe('legacy-job');
  });
});

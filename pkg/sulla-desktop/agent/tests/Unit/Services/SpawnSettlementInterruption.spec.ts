// SPDX-License-Identifier: GPL-2.0-or-later
import '../../Support/TestHomeEnv';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeferredStallInput } from '../../../app/Services/DeferredStallInput';
import * as delegation from '../../../database/models/AgentDelegationModel';
import * as persistence from '../../../nodes/ThreadStateStore';
import { agentDefinitionService } from '../../../services/AgentDefinitionService';
import { agentJobLifecycle } from '../../../services/AgentJobLifecycleService';
import { agentWaitProvider } from '../../../services/AgentWaitServices';
import { budgetPolicyService } from '../../../services/BudgetPolicyService';
import { GraphRegistry } from '../../../services/GraphRegistry';
import * as delivery from '../../../tools/agents/jobDelivery';
import * as exchange from '../../../tools/agents/jobExchange';
import * as jobs from '../../../tools/agents/jobRegistry';
import { SpawnAgentWorker } from '../../../tools/agents/spawn_agent';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => 'test', isPackaged: false }, safeStorage: {} }));
vi.mock('@pkg/main/SleepPreventionService', () => ({ acquireChatActivity: () => {}, releaseChatActivity: () => {} }));
vi.mock('@pkg/backend/providerCliUpdates', () => ({ captureProviderCliSnapshot: () => Promise.resolve({}) }));
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const task = new AbortController();
  const state: any = { messages: [], metadata: {} };
  const job: any = { jobId: 'synthetic-job', status: 'running', tasks: [{ status: 'running' }] };
  vi.spyOn(agentDefinitionService, 'findBySlug').mockResolvedValue(null);
  vi.spyOn(budgetPolicyService, 'read').mockResolvedValue(null);
  vi.spyOn(jobs, 'getAllJobs').mockResolvedValue([]);
  vi.spyOn(jobs, 'createJob').mockResolvedValue(job);
  vi.spyOn(jobs, 'getTaskAbortSignal').mockReturnValue(task.signal);
  const read = vi.spyOn(jobs, 'getJob').mockResolvedValue(job);
  const update = vi.spyOn(jobs, 'updateJobTask').mockResolvedValue(undefined);
  vi.spyOn(jobs, 'stoppedTaskResult').mockResolvedValue(undefined);
  const complete = vi.spyOn(jobs, 'recordTaskCompletion').mockResolvedValue(undefined);
  vi.spyOn(jobs, 'completeJob').mockResolvedValue(undefined);
  vi.spyOn(jobs, 'markCompletionDelivered').mockResolvedValue(undefined);
  const publish = vi.spyOn(delivery, 'deliverJobCompletion').mockResolvedValue(true);
  vi.spyOn(exchange, 'emitSubAgentExchange').mockResolvedValue(undefined);
  vi.spyOn(delegation, 'safeStartDelegation').mockResolvedValue(null);
  vi.spyOn(delegation, 'safeMarkDelegationsDelivered').mockResolvedValue(undefined);
  const save = vi.spyOn(persistence, 'saveThreadState').mockResolvedValue(undefined);
  const cancel = vi.spyOn(agentWaitProvider, 'cancel').mockResolvedValue(true);
  vi.spyOn(agentWaitProvider.repository, 'pending').mockResolvedValue({ state: 'scheduled' } as any);
  vi.spyOn(agentJobLifecycle, 'openChildren').mockResolvedValue(0);
  const graph = {
    execute: () => {
      DeferredStallInput.settledInputs(state, DeferredStallInput.actionableMessages(state));
      state.messages.push({ role: 'assistant', content: 'preceding graph text' });
      return Promise.resolve(state);
    },
  };
  vi.spyOn(GraphRegistry, 'getOrCreateAgentGraph').mockImplementation((_channel, threadId) => {
    state.metadata.threadId = threadId;
    return Promise.resolve({ graph, state } as any);
  });
  const worker = new SpawnAgentWorker();
  const run = (): Promise<unknown> => (worker as any).launchHidden([{ prompt: 'test work', runLocation: 'vm' }], { async: false }, 0, []);
  return { task, state, job, read, update, complete, publish, save, cancel, run };
}

describe('hidden spawn settlement at runtime drain', () => {
  it('preserves the task and wait when a drain overtakes the first return lookup', async() => {
    const h = fixture();
    h.read.mockImplementationOnce(() => {
      agentJobLifecycle.interruptRunners();
      return Promise.resolve(h.job);
    });
    await expect(h.run()).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.task.signal.aborted).toBe(false);
    expect(h.save).toHaveBeenCalledWith(h.state);
    expect(h.update.mock.calls.map(call => call[2].status)).toEqual(['running']);
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('keeps a task stop terminal when it overtakes that same lookup', async() => {
    const h = fixture();
    const stopped = { status: 'stopped' as const, label: 'worker', threadId: 'stopped-thread', output: 'stopped' };
    vi.mocked(jobs.stoppedTaskResult).mockResolvedValue(stopped);
    h.read.mockImplementationOnce(() => {
      h.task.abort();
      return Promise.resolve(h.job);
    });
    await h.run();
    expect(h.cancel).toHaveBeenCalled();
    expect(h.complete).toHaveBeenCalledWith(h.job.jobId, 0, stopped);
    expect(h.publish).toHaveBeenCalledWith(h.job, [stopped], 0, undefined);
  });

  it('publishes the committed contract, not the preceding graph text, when a parked wait drains', async() => {
    const h = fixture();
    const run = h.run();
    const result = { status: 'completed', summary: 'recorded contract' };
    try {
      await vi.waitFor(() => expect(agentJobLifecycle.hasLiveWaiter(h.state.metadata.threadId)).toBe(true));
      Object.assign(h.job.tasks[0], { returnedAt: 1, result });
    } finally {
      agentJobLifecycle.interruptRunners();
      await run;
    }
    expect(h.task.signal.aborted).toBe(false);
    const expected = expect.objectContaining({ result, output: expect.stringContaining('recorded contract') });
    expect(h.complete).toHaveBeenCalledWith(h.job.jobId, 0, expected);
    expect(h.publish).toHaveBeenCalledWith(h.job, [expected], 0, undefined);
  });
});

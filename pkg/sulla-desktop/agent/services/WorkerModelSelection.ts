// SPDX-License-Identifier: GPL-2.0-or-later
import { InfrastructureFailure } from '../languagemodels/providerRecovery';
import { selectWorkerCandidate, type WorkerModelRoute } from '../languagemodels/workerModelBindings';
import { saveThreadState } from '../nodes/ThreadStateStore';

import type { ModelCandidate } from '../languagemodels/modelRouter';
import type { BaseThreadState } from '../nodes/Graph';

/** Persists captured execution choices through the existing job ownership checks. */
export class WorkerModelSelection {
  async recordInheritedSelection(state: BaseThreadState, candidate: ModelCandidate): Promise<void> {
    const meta = state.metadata as any;
    if (!meta.delegatedJobId || !Number.isInteger(meta.delegatedTaskIndex) || meta.workerModelRoute || meta.workerModelChatOverride) return;
    const prior: ModelCandidate | undefined = meta.savedInheritedModel;
    if (prior?.provider === candidate.provider && prior.model === candidate.model && prior.effort === candidate.effort) return;
    const { agentJobProvider } = await import('../app/Providers/AgentJobServiceProvider');
    const saved = await agentJobProvider.states.mutateJob(meta.delegatedJobId, job => {
      const task = job.tasks[meta.delegatedTaskIndex];
      if (!task || task.threadId !== meta.threadId || (task.generation ?? 1) !== (meta.delegatedGeneration ?? 1) ||
          !['running', 'parked'].includes(job.status) || !['queued', 'running', 'parked'].includes(task.status) || task.workerModelRoute) {
        throw new InfrastructureFailure('Inherited worker selection belongs to a different execution.');
      }
      return { ...job, tasks: job.tasks.map((item, index) => index === meta.delegatedTaskIndex ? { ...item, inheritedModel: { ...candidate } } : item) };
    }, undefined, false);
    if (!saved) throw new InfrastructureFailure('Cannot record model selection for the delegated job.');
    meta.savedInheritedModel = { ...candidate };
  }

  /** Persist before provider invocation, including the transition to a fallback. */
  async persistSelection(state: BaseThreadState, candidate: ModelCandidate): Promise<void> {
    const meta = state.metadata as any;
    const route = meta.workerModelRoute as WorkerModelRoute | undefined;
    if (!route || meta.workerModelChatOverride) return;
    const next = selectWorkerCandidate(route, candidate);
    try {
      if (meta.workerModelTask) {
        const { agentJobProvider } = await import('../app/Providers/AgentJobServiceProvider');
        const { jobId, taskIndex } = meta.workerModelTask;
        const persisted = await agentJobProvider.states.mutateJob(jobId, job => {
          const task = job.tasks[taskIndex];
          if (!['running', 'parked'].includes(job.status) || !task || !['queued', 'running', 'parked'].includes(task.status)) throw new InfrastructureFailure('Worker job is no longer active; refusing model invocation.');
          if (task.threadId !== meta.threadId || (task.generation ?? 1) !== meta.workerModelTask.generation || (task.workerModelRoute?.editToken ?? '') !== (next.editToken ?? '') || task.workerModelRoute?.revision !== next.revision || task.workerModelRoute?.agentId !== next.agentId || task.workerModelRoute.selected > next.selected) throw new InfrastructureFailure('Worker execution ownership changed; refusing stale model selection.');
          return { ...job, tasks: job.tasks.map((item, index) => index === taskIndex ? { ...item, workerModelRoute: next } : item) };
        }, undefined, false);
        if (!persisted) throw new InfrastructureFailure('Worker job is unavailable; refusing model invocation.');
      }
      meta.workerModelRoute = next;
      await saveThreadState(state);
    } catch (error) { throw new InfrastructureFailure('Worker model selection could not be saved safely.', error) }
  }
}

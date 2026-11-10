// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BaseTool, ToolResponse } from '../base';
import { contractCandidate, contractReturnStatus, normalizeContract, validateContractResult } from './contract';
import { deliverJobCompletion, returnedJobResult } from './jobDelivery';
import { emitSubAgentExchange } from './jobExchange';
import { completeJob, findTaskByThread, recordTaskCompletion, recordTaskReturn, releaseJobWatcher } from './jobRegistry';
import { safeFinishDelegationByRef } from '../../database/models/AgentDelegationModel';
import { agentJobProvider } from '../../app/Providers/AgentJobServiceProvider';
import { ReviewItemClosureValidator } from '../../app/Services/ReviewItemClosureValidator';

import type { AgentJob } from './jobRegistry';

/**
 * The one way a delegated child finishes: hidden worker or agent tab. The
 * value is checked against the job's contract; a mismatch is refused so the
 * child can fix it and call again. `chat/return_contract` is an alias.
 *
 * Hidden child: the return is recorded and its runner hands it to the parent
 * when the run ends. Tab child: the return closes the job right here and
 * wakes the parent, because a tab's turns never end the job on their own.
 */
export class ReturnResultWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const threadId = String(this.state?.metadata?.threadId ?? '').trim();
    if (!threadId) return { successBoolean: false, responseString: 'return_result must be called from a delegated agent\'s own thread.' };

    const owner = await findTaskByThread(threadId);
    if (!owner) {
      return { successBoolean: false, responseString: 'No delegated job owns this thread, so there is no contract to return.' };
    }
    const { job, taskIndex } = owner;
    const requested = String(input.jobId ?? input.contractId ?? '').trim();
    if (requested && requested !== job.jobId && requested !== `${ job.jobId }#${ taskIndex }`) {
      return { successBoolean: false, responseString: `Only the child thread that owns contract "${ requested }" can return it.` };
    }
    const task = job.tasks[taskIndex];
    if (task.returnedAt) return { successBoolean: false, responseString: `Job ${ job.jobId } already returned its contract.` };
    if (!['running', 'parked'].includes(job.status)) return { successBoolean: false, responseString: `Job ${ job.jobId } is ${ job.status }; it no longer accepts a return.` };

    const reviewUpdates = Array.isArray(input.reviewUpdates) ? input.reviewUpdates : [];
    const openReviewItems = await agentJobProvider.reviewItems.itemsForTask(job.jobId, taskIndex, true);
    const reviewError = new ReviewItemClosureValidator().validate(reviewUpdates, openReviewItems.map(item => item.id));
    if (reviewError) return { successBoolean: false, responseString: reviewError };
    for (const update of reviewUpdates) {
      if (update.status === 'acknowledged') await agentJobProvider.reviewItems.acknowledge(job.jobId, taskIndex, update.id);
      else await agentJobProvider.reviewItems.close(job.jobId, taskIndex, update.id, update.status, update.commit, update.reason, 'worker');
    }
    const obligation = await agentJobProvider.reviewGate.refusal(job.jobId, taskIndex);
    if (obligation) return { successBoolean: false, responseString: obligation };

    // A manager owns its children until they settle or are explicitly stopped.
    // Returning here would make its thread terminal and strand every later
    // child completion, so parking is expressed only by ending the turn.
    const runningChildren = await agentJobProvider.service.openChildrenForThread(threadId);
    if (runningChildren > 0) {
      return {
        successBoolean: false,
        responseString: `you have ${ runningChildren } running children; park by ending your turn, or stop them first`,
      };
    }

    const contract = task.contract ?? normalizeContract(undefined);
    const candidate = contractCandidate(contract, input);
    const mismatch = validateContractResult(contract, candidate);
    if (mismatch) {
      return {
        successBoolean: false,
        responseString: `Contract result does not match the expected schema: ${ mismatch }. Fix the result and call return_result again.`,
      };
    }

    const status = contractReturnStatus(contract, candidate);
    const summary = contract.schema && typeof input.summary === 'string' && input.summary.trim() ? input.summary.trim() : undefined;
    let recorded: AgentJob;
    try {
      recorded = await recordTaskReturn(job.jobId, taskIndex, {
        result: candidate,
        summary,
        status: status === 'failed' ? 'error' : status,
      });
    } catch (err) {
      return { successBoolean: false, responseString: (err as Error).message };
    }

    // Returning the contract is the terminal action for this delegated turn.
    // AgentNode reads this after tool execution (and in its error path) so it
    // does not start a post-return provider call or publish a late runtime error.
    if (this.state?.metadata) {
      (this.state.metadata as any).delegatedContractReturned = {
        jobId: job.jobId,
        taskIndex,
        returnedAt: recorded.tasks[taskIndex]?.returnedAt ?? Date.now(),
      };
    }

    if (recorded.visibility !== 'tab') {
      // A rehydrated parked manager has no original promise chain left to
      // settle it after a restart, so its return commits and wakes its parent
      // here. A live runner sees the same recorded return and completion is
      // idempotently coalesced by job id.
      if (job.status === 'parked' || Number(job.restartResumeCount) > 0) {
        await finishRecoveredJob(recorded);
        return {
          successBoolean: true,
          responseString: `Contract "${ contract.name }" returned to the parent. Parked job ${ job.jobId } is closed.`,
        };
      }
      return {
        successBoolean: true,
        responseString: `Contract "${ contract.name }" returned for job ${ job.jobId }. End your turn now; your parent receives it when this run ends.`,
      };
    }

    await finishTabJob(recorded, taskIndex);
    return {
      successBoolean: true,
      responseString: `Contract "${ contract.name }" returned to the parent chat. Job ${ job.jobId } is closed.`,
    };
  }
}


async function finishRecoveredJob(job: AgentJob): Promise<void> {
  if (!job.tasks.every(task => task.returnedAt)) return;
  const results = job.tasks.map(task => returnedJobResult(task, task.label, task.threadId ?? ''));
  for (const [taskIndex,result] of results.entries()) await recordTaskCompletion(job.jobId, taskIndex, result);
  await completeJob(job.jobId, results);
  await deliverJobCompletion(job, results);
  const { agentJobLifecycle } = await import('../../services/AgentJobLifecycleService');
  for (const task of job.tasks) agentJobLifecycle.wake(task.threadId ?? '');
}

/** Close a tab job on its return: settle, tell both chats, wake the parent. */
async function finishTabJob(job: AgentJob, taskIndex: number): Promise<void> {
  const task = job.tasks[taskIndex];
  const threadId = task.threadId ?? '';
  const result = returnedJobResult(task, task.label, threadId);

  releaseJobWatcher(job.jobId);
  await completeJob(job.jobId, [result]);
  await emitSubAgentExchange(job.parentChannel, job.parentThreadId, {
    direction:      'from_agent',
    agentId:        task.agentId,
    label:          task.label,
    summary:        `${ task.label } returned ${ result.contract ?? 'its result' }`,
    detail:         result.output,
    status:         result.status === 'completed' ? 'done' : 'failed',
    jobId:          job.jobId,
    taskIndex,
    conversationId: threadId,
  });
  const { confirmAgentTabReturn } = await import('../../services/AgentTabOpener');
  if (threadId) confirmAgentTabReturn(threadId, result.contract ?? 'result');

  const delivered = await deliverJobCompletion(job, [result], taskIndex);
  await safeFinishDelegationByRef(job.jobId, {
    outcome:         result.status === 'completed' ? 'completed' : 'failed',
    detail:          result.status === 'completed' ? '' : `${ result.status }: ${ result.output }`,
    resultDelivered: delivered,
  });
}

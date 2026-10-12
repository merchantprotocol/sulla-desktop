import { BaseTool, ToolResponse } from '../base';
import { contractCandidate, contractReturnStatus, normalizeContract, validateContractResult } from './contract';
import { deliverJobCompletion, returnedJobResult } from './jobDelivery';
import { emitSubAgentExchange } from './jobExchange';
import { completeJob, findTaskByThread, recordTaskReturn, releaseJobWatcher } from './jobRegistry';
import { safeFinishDelegationByRef } from '../../database/models/AgentDelegationModel';

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
    if (job.status !== 'running') return { successBoolean: false, responseString: `Job ${ job.jobId } is ${ job.status }; it no longer accepts a return.` };

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

    if (recorded.visibility !== 'tab') {
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

  const delivered = await deliverJobCompletion(job, [result]);
  await safeFinishDelegationByRef(job.jobId, {
    outcome:         result.status === 'completed' ? 'completed' : 'failed',
    detail:          result.status === 'completed' ? '' : `${ result.status }: ${ result.output }`,
    resultDelivered: delivered,
  });
}

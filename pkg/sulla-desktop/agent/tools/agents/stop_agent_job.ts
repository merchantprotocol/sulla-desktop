// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { emitSubAgentExchange } from './jobExchange';
import { BaseTool, ToolResponse } from '../base';
import { agentJobProvider } from '../../app/Providers/AgentJobServiceProvider';
import { getJob, releaseJobWatcher, stopJobCascade, stopJobTask } from './jobRegistry';
import { safeFinishDelegationByRef } from '../../database/models/AgentDelegationModel';
import { StopPrincipal, type StopPrincipalValue } from '../../app/ValueObjects/StopPrincipal';

export interface StopAgentJobOptions { taskIndex?: number; mode?: 'hard' | 'wrap_up'; gracePeriodSeconds?: number }
export async function stopAgentJob(jobId: string, principal: StopPrincipalValue | undefined, reason = 'agent request (no reason given)', options: StopAgentJobOptions = {},callerMetadata?:Record<string,any>): Promise<ToolResponse> {
  if (!jobId) {
    return {
      successBoolean: false,
      responseString: 'jobId is required (the id returned by an async spawn_agent call).',
    };
  }

  if (!principal) return { successBoolean: false, responseString: 'Cannot stop job: cannot verify caller.' };
  const job = await getJob(jobId);
  const taskIndex = options.taskIndex;
  if (taskIndex !== undefined && (!Number.isInteger(taskIndex) || taskIndex < 0)) return { successBoolean: false, responseString: 'taskIndex must be a non-negative integer.' };
  if (options.mode === 'wrap_up') {
    const targets = taskIndex === undefined ? (job?.tasks ?? []).map((_, index) => index) : [taskIndex];
    const stoppedBy = StopPrincipal.attribution(principal);
    const who = stoppedBy === 'human' ? 'human' : 'agentId' in stoppedBy ? stoppedBy.agentId : stoppedBy.system;
    const message = `[Stop requested by ${ who }] Finish your current step and return your contract now with what you have`;
    const graceSeconds = Math.max(1, options.gracePeriodSeconds ?? 120);
    const {sendJobMessage}=await import('./send_job_message');
    const sent=await sendJobMessage({jobId,...(taskIndex===undefined?{}:{taskIndex}),message},callerMetadata);
    if(!sent.successBoolean)return sent;
    await agentJobProvider.wrapUp.request(jobId, targets, principal, reason, graceSeconds, message,true);
    return { successBoolean: true, responseString: `Wrap-up requested for job "${ jobId }"${ taskIndex === undefined ? '' : ` task ${ taskIndex }`}; it has ${ graceSeconds } seconds to return before hard stop.` };
  }
  const outcome = taskIndex === undefined
    ? await stopJobCascade(jobId, principal, reason)
    : await stopJobTask(jobId, taskIndex, principal, reason);

  switch (outcome) {
  case 'stopped':
    const effectiveOwner=await agentJobProvider.custody.resolveOwner(jobId,taskIndex);
    // A tab child runs as a desktop chat, not under the job's abort signal:
    // stop its live turn directly and close its delegation record.
    if (job?.visibility === 'tab') {
      releaseJobWatcher(jobId);
      const { stopAgentTab } = await import('../../services/AgentTabOpener');
      const threadId = job.tasks[0]?.threadId;
      if (threadId) await stopAgentTab(threadId, `The parent agent stopped job ${ jobId }. This tab no longer reports back.`);
      await safeFinishDelegationByRef(jobId, { outcome: 'failed', detail: 'stopped by parent' });
    }
    const killedByHuman = principal.kind === 'human';
    await Promise.all((job?.tasks ?? []).map((task, currentTaskIndex) => taskIndex !== undefined && currentTaskIndex !== taskIndex ? Promise.resolve() : emitSubAgentExchange(
      effectiveOwner?.channel, effectiveOwner?.threadId, {
        direction: 'from_agent', agentId: task.agentId, label: task.label,
        summary: killedByHuman ? `${ task.label } was killed by human` : `${ task.label } was stopped`,
        detail: killedByHuman ? 'Killed by human. Its result will not be delivered.' : `Stop requested for job ${ jobId } before the sub-agent finished.`,
        status: 'stopped', jobId, taskIndex: currentTaskIndex, conversationId: task.threadId,
      },
    )));
    return {
      successBoolean: true,
      responseString: `Stop requested for job "${ jobId }"${ taskIndex === undefined ? '' : ` task ${ taskIndex }`}. The targeted sub-agent(s) will unwind at their next step.`,
    };
  case 'forbidden':
    const owner=await agentJobProvider.custody.resolveOwner(jobId,taskIndex);
    return { successBoolean: false, responseString: `Cannot stop job "${ jobId }": it is owned by ${ owner?.agentId ?? 'another agent' }. Only its owner, an ancestor, or the human can stop it.` };
  case 'already-finished':
    return {
      successBoolean: false,
      responseString: `Job "${ jobId }" is not running (already completed, failed, or stopped). Nothing to cancel.`,
    };
  case 'not-found':
  default:
    return {
      successBoolean: false,
      responseString: `Job "${ jobId }" not found. It may have already settled and been cleaned up (jobs are pruned 1 hour after finishing).`,
    };
  }
}

/**
 * Kill switch for delegated jobs from spawn_agent, hidden or tab.
 * Fires the job's AbortController, which is threaded into every sub-agent that
 * job spawned via `metadata.options.abort` — the same signal the user's stop
 * button uses — so the sub-agent graphs unwind cooperatively.
 *
 * Cooperative, not preemptive: a sub-agent blocked inside an in-flight LLM or
 * tool call finishes that call first, then sees the aborted signal on its next
 * step and stops. There is no forced process kill (jobs run in-process, not as
 * child processes).
 */
export class StopAgentJobWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const metadata = this.state?.metadata;
    const verified=await agentJobProvider.custodyCallerVerifier.verify(metadata);
    const caller = StopPrincipal.agent(verified.agentId, verified.threadId);
    return stopAgentJob(typeof input.jobId === 'string' ? input.jobId : '', caller, typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : 'agent request (no reason given)', {
      taskIndex: input.taskIndex === undefined ? undefined : Number(input.taskIndex),
      mode: input.mode === 'wrap_up' ? 'wrap_up' : 'hard',
      gracePeriodSeconds: input.gracePeriodSeconds === undefined ? undefined : Number(input.gracePeriodSeconds),
    },metadata);
  }
}

// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentJobMessagingModel } from '../../database/models/AgentJobMessagingModel';
import { PendingReturnedTaskMessage } from '../../app/Services/PendingReturnedTaskMessage';
import { agentJobProvider } from '../../app/Providers/AgentJobServiceProvider';
import { injectSteer } from '../../utils/steerChannel';
import { BaseTool, ToolResponse } from '../base';
import { getJob } from './jobRegistry';

/**
 * Persist a message for one or all open tasks of a job and deliver it.
 * Hidden children get it live (steer) or at their next model call. A tab
 * child is a desktop chat: the message steers its live turn, or starts a turn
 * when it is idle, through the same inject path the old message_tab used.
 */
export async function sendJobMessage(input: { jobId: string; taskIndex?: number; message: string; reviewItems?: string[]; closeReviewItems?: Array<{ id: string; status: 'wont_fix'; reason: string }> }, metadata?: Record<string,any>): Promise<ToolResponse> {
  const { jobId, taskIndex, message } = input;
  if (!jobId || !message) {
    return { successBoolean: false, responseString: 'jobId and a non-empty message are required.' };
  }
  if (taskIndex !== undefined && (!Number.isInteger(taskIndex) || taskIndex < 0)) {
    return { successBoolean: false, responseString: 'taskIndex must be a non-negative integer.' };
  }
  if ((input.closeReviewItems ?? []).some(close => !close.id || !close.reason?.trim())) {
    return { successBoolean: false, responseString: 'Manager wont_fix closure requires an item id and non-empty reason.' };
  }

  // Owner-only authority: the caller must be the current custody owner, or an
  // ancestor proven against the exact owner version still held under the lock.
  // Review-item writes and message rows commit in the same custody transaction.
  const caller=metadata?await agentJobProvider.custodyCallerVerifier.verify(metadata):undefined;
  const snapshot=caller?await agentJobProvider.custody.resolveOwner(jobId,taskIndex):undefined;
  const snapshotAncestor=caller&&snapshot&&caller.threadId!==snapshot.threadId?await agentJobProvider.custodyLineage.isAncestor(caller.threadId,snapshot.threadId):false;
  const locked=await agentJobProvider.custody.withOwner(jobId,taskIndex,async(client,owner)=>{
    if(caller){
      const same=caller.threadId===owner.threadId;
      const unchanged=snapshot?.threadId===owner.threadId&&snapshot.version===owner.version;
      if(!same&&!(unchanged&&snapshotAncestor))return {kind:'forbidden',owner} as const;
    }
    const targets=await agentJobProvider.messaging.openTargetsWithClient(client,jobId,taskIndex);
    if(targets.length===0)return {kind:'no-targets'} as const;
    if(targets.some(target=>!['running','parked'].includes(target.jobStatus)))return {kind:'not-running'} as const;
    const reviews=agentJobProvider.reviewItems.withClient(client);
    const reviewIds: string[] = [];
    const reviewIdsByTask: Record<number, string[]> = {};
    const closedReviewIds = new Set<string>();
    const reviewMessageByTask = new Map<number, string>();
    for (const target of targets) {
      for (const close of input.closeReviewItems ?? []) {
        const open = await reviews.itemsForTask(jobId, target.taskIndex, true);
        if (open.some(item => item.id === close.id)) {
          await reviews.close(jobId, target.taskIndex, close.id, 'wont_fix', undefined, close.reason.trim(), 'manager');
          closedReviewIds.add(close.id);
        }
      }
      const texts = input.reviewItems ?? [];
      if (texts.length) {
        const ids = await reviews.createForTask(jobId, target.taskIndex, texts);
        reviewIds.push(...ids);
        reviewIdsByTask[target.taskIndex] = ids;
        const reviewText = ids.map((id, index) => `${id}: ${texts[index]}`).join('\n');
        reviewMessageByTask.set(target.taskIndex, `${message}\n\nTracked review items (close each one):\n${reviewText}\nAcknowledge each in your next report_progress; close with fixed + commit sha or wont_fix + reason.`);
      }
    }
    const unknownClose = (input.closeReviewItems ?? []).find(item => !closedReviewIds.has(item.id));
    if (unknownClose) {
      const validIds = (await Promise.all(targets.map(target => reviews.itemsForTask(jobId, target.taskIndex, true)))).flat().map(item => item.id).join(', ') || '(none)';
      return {kind:'unknown-review-item',id:unknownClose.id,validIds} as const;
    }
    const queued=await agentJobProvider.messaging.queueForTargetsWithClient(client,jobId,targets,target=>reviewMessageByTask.get(target.taskIndex)??message);
    return {kind:'queued',queued,reviewIds,reviewIdsByTask} as const;
  });
  if(!locked)return {successBoolean:false,responseString:`Job "${jobId}" not found.`};
  if(locked.kind==='forbidden')return {successBoolean:false,responseString:`Cannot message job "${jobId}": current owner is ${locked.owner.agentId} (${locked.owner.channel}/${locked.owner.threadId}).`};
  if(locked.kind==='not-running')return { successBoolean: false, responseString: `Job "${ jobId }" is no longer running.` };
  if(locked.kind==='unknown-review-item')return { successBoolean: false, responseString: `Unknown review item "${locked.id}". Valid open ids: ${locked.validIds}.` };
  if(locked.kind==='no-targets'){
    const returnedJob = await agentJobProvider.jobs.job(jobId);
    const pendingTaskMessage = new PendingReturnedTaskMessage();
    const pendingReturnedTask = returnedJob?.tasks.find((task, index) =>
      (taskIndex === undefined || taskIndex === index) && pendingTaskMessage.forTask(task));
    const pendingMessage = pendingReturnedTask && pendingTaskMessage.forTask(pendingReturnedTask);
    if (pendingMessage) return { successBoolean: false, responseString: pendingMessage };
    return {
      successBoolean: false,
      responseString: taskIndex === undefined
        ? `Job "${ jobId }" has no queued or running tasks.`
        : `Job "${ jobId }" has no task at index ${ taskIndex } (or it has already finished).`,
    };
  }
  const { queued, reviewIds, reviewIdsByTask } = locked;

  const job = await getJob(jobId);
  let deliveredLive = 0;
  const notWoken: Array<{ taskIndex: number; reason: string }> = [];

  for (const { target, record } of queued) {
    if (!target.threadId) continue;
    const meta = {
      jobId,
      taskIndex:          target.taskIndex,
      jobMessageId:       record.id,
      jobMessageThreadId: target.threadId,
    };

    if (job?.visibility === 'tab') {
      const { messageAgentTab } = await import('../../services/AgentTabOpener');
      try {
        await messageAgentTab(target.threadId, job.tasks[target.taskIndex]?.agentId ?? '', message, meta);
        await AgentJobMessagingModel.markMessagesDelivered([record.id], target.threadId);
        deliveredLive += 1;
      } catch (err) {
        console.warn(`[send_job_message] tab delivery failed for ${ jobId }:`, (err as Error).message);
      }
      continue;
    }

    if (target.taskStatus === 'parked') {
      // A manager message wins the durable wait race. CAS cancellation makes
      // the later timer a no-op before the existing parked-wake path runs.
      const { agentWaitProvider } = await import('../../services/AgentWaitServices');
      await agentWaitProvider.cancel(jobId, target.taskIndex);
      const { getBackendGraphWebSocketService } = await import('../../services/BackendGraphWebSocketService');
      // The ack is written by dispatchToAgent itself, only once the woken
      // turn actually consumed this message (graph.execute succeeded) — the
      // same turnConsumedInput gate used for completion steers. Acking here
      // would mark it delivered even if the turn never ran (provider not
      // ready, launch error, abort), losing the message for good.
      //
      // wakeParkedAgent throws when the job is no longer parked by the time
      // it resolves (completed/stopped/failed after targetsForJob read above,
      // or its agent definition went missing) or is left mid-run and declines
      // to dispatch. Either way the message stays queued in agent_job_messages
      // for redelivery — degrade this one target and keep processing the rest.
      try {
        // false means the thread is mid-turn right now: wakeParkedAgent
        // declined to dispatch (so it cannot abort that live run) and the
        // already-queued message stays pending for the task's next turn.
        const woken = await getBackendGraphWebSocketService().wakeParkedAgent(job?.parentChannel ?? 'sulla-desktop', target.threadId, message, job?.tasks[target.taskIndex]?.agentId, meta);
        if (woken) deliveredLive += 1;
      } catch (err) {
        console.warn(`[send_job_message] parked wake failed for ${ jobId } task ${ target.taskIndex }:`, (err as Error).message);
        notWoken.push({ taskIndex: target.taskIndex, reason: (err as Error).message });
      }
      continue;
    }
    const { GraphRegistry } = await import('../../services/GraphRegistry');
    const running = GraphRegistry.get(target.threadId);
    if (!running) continue;
    const accepted = injectSteer(running.state as any, {
      role:    'user',
      content: `[Message from orchestrator]\n${ message }`,
      metadata: {
        source:       'orchestrator_job_message',
        inputSource:  'system',
        ...meta,
      },
    } as any);
    if (accepted) {
      await AgentJobMessagingModel.markMessagesDelivered([record.id], target.threadId);
      deliveredLive += 1;
    }
  }

  return {
    successBoolean: true,
    responseString: JSON.stringify({
      jobId,
      targetedTasks: queued.map(({ target }) => target.taskIndex),
      deliveredLive,
      queuedForNextBoundary: queued.length - deliveredLive,
      ...(reviewIds.length ? { reviewItemIds: reviewIds, reviewItemIdsByTask: reviewIdsByTask } : {}),
      ...(notWoken.length ? {
        notWoken: notWoken.map(entry => ({
          taskIndex: entry.taskIndex,
          reason: `job is no longer parked, or its agent definition is missing (${ entry.reason }); the message stays queued and will be delivered at the task's next turn`,
        })),
      } : {}),
    }, null, 2),
  };
}

export class SendJobMessageWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    return sendJobMessage({
      jobId:     String(input.jobId ?? '').trim(),
      message:   String(input.message ?? '').trim(),
      taskIndex: input.taskIndex === undefined ? undefined : Number(input.taskIndex),
      reviewItems: Array.isArray(input.reviewItems) ? input.reviewItems.map(String) : undefined,
      closeReviewItems: Array.isArray(input.closeReviewItems) ? input.closeReviewItems : undefined,
    }, (this.state as any)?.metadata);
  }
}

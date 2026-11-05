// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentJobMessagingModel } from '../../database/models/AgentJobMessagingModel';
import { injectSteer } from '../../utils/steerChannel';
import { BaseTool, ToolResponse } from '../base';
import { getJob } from './jobRegistry';
import { completeJob, recordTaskCompletion } from './jobRegistry';
import { deliverJobCompletion } from './jobDelivery';
import { AgentTaskReopenService, type AgentTaskReopenSettlement } from '../../app/Services/AgentTaskReopenService';
import { AgentJobResultHistoryRepository } from '../../app/Repositories/AgentJobResultHistoryRepository';
import { DesktopPostgresConnection } from '../../app/Database/DesktopPostgresConnection';
import { postgresClient } from '../../database/PostgresClient';
import { SystemClock } from '@sulla/foundation';
import { agentJobProvider } from '../../app/Providers/AgentJobServiceProvider';
import { hiddenAgentTaskRunnerRegistry } from '../../services/HiddenAgentTaskRunner';
import type { AgentJobResult } from './jobRegistry';

class ReopenedTaskSettlement implements AgentTaskReopenSettlement {
  async settle(jobId: string, taskIndex: number, result: AgentJobResult): Promise<void> {
    await recordTaskCompletion(jobId, taskIndex, result);
    const job = await getJob(jobId);
    if (!job) return;
    await completeJob(jobId, job.tasks.map((task, index) => index === taskIndex ? result : task.completion).filter(Boolean) as AgentJobResult[]);
    const settled = await getJob(jobId);
    if (settled) await deliverJobCompletion(settled, [result], taskIndex, result.status === 'error' ? result.output : undefined);
  }

  async fail(jobId: string, taskIndex: number, error: Error): Promise<void> {
    await this.settle(jobId, taskIndex, { label: `task-${ taskIndex }`, status: 'error', output: `Reopen failed: ${ error.message }`, threadId: '' });
  }
}

const refusalText: Record<string, string> = {
  stopped: 'stopped tasks cannot be reopened; launch a new task',
  failed: 'failed tasks cannot be reopened because replay could duplicate side effects',
  limit_reached: 'this task reached the maximum of 5 reopens',
  active_lease: 'this task is already reopening',
  already_reopening: 'another message already reopened this task; your message was queued for that generation',
  missing_runner: 'the original runtime session is unavailable; launch a new task',
  not_finished: 'the task is not finished',
  not_found: 'the task does not exist',
};

/**
 * Persist a message for one or all open tasks of a job and deliver it.
 * Hidden children get it live (steer) or at their next model call. A tab
 * child is a desktop chat: the message steers its live turn, or starts a turn
 * when it is idle, through the same inject path the old message_tab used.
 */
export async function sendJobMessage(input: { jobId: string; taskIndex?: number; message: string }): Promise<ToolResponse> {
  const { jobId, taskIndex, message } = input;
  if (!jobId || !message) {
    return { successBoolean: false, responseString: 'jobId and a non-empty message are required.' };
  }
  if (taskIndex !== undefined && (!Number.isInteger(taskIndex) || taskIndex < 0)) {
    return { successBoolean: false, responseString: 'taskIndex must be a non-negative integer.' };
  }

  const targets = await AgentJobMessagingModel.targetsForJob(jobId, taskIndex);
  if (targets.length === 0) {
    if (taskIndex !== undefined) {
      const job = await getJob(jobId);
      const task = job?.tasks[taskIndex];
      if (job && task) {
        const backend = (await import('../../services/BackendGraphWebSocketService')).getBackendGraphWebSocketService();
        const reopen = new AgentTaskReopenService(
          agentJobProvider.jobs,
          new AgentJobResultHistoryRepository(new DesktopPostgresConnection(postgresClient)),
          { receive: entry => backend.receiveAgentInbox(entry) },
          hiddenAgentTaskRunnerRegistry,
          new SystemClock(),
          new ReopenedTaskSettlement(),
        );
        const outcome = await reopen.reopen(jobId, taskIndex, message, job.parentAgentId ?? job.parentChannel ?? 'manager');
        if (outcome.reopened) return { successBoolean: true, responseString: JSON.stringify({ jobId, targetedTasks: [taskIndex], reopenedGeneration: outcome.generation }, null, 2) };
        return { successBoolean: false, responseString: refusalText[outcome.reason] ?? `Task cannot be reopened (${ outcome.reason }).` };
      }
    }
    return {
      successBoolean: false,
      responseString: taskIndex === undefined
        ? `Job "${ jobId }" has no queued or running tasks.`
        : `Job "${ jobId }" has no task at index ${ taskIndex } (or it has already finished).`,
    };
  }
  if (targets.some(target => !['running', 'parked'].includes(target.jobStatus))) {
    return { successBoolean: false, responseString: `Job "${ jobId }" is no longer running.` };
  }

  const job = await getJob(jobId);
  const queued = await Promise.all(targets.map(async(target) => ({
    target,
    record: await AgentJobMessagingModel.queueMessage(target, message),
  })));
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
    });
  }
}

// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { chatHeartbeatProvider } from '../../app/Providers/ChatHeartbeatServiceProvider';
import { getJob } from '../agents/jobRegistry';
import { BaseTool, ToolResponse } from '../base';

import { CHAT_HEARTBEAT_JOB_MIN_INTERVAL_MINUTES, DEFAULT_CHAT_HEARTBEAT_MESSAGE, normalizeChatHeartbeatConfig } from '@pkg/shared/chatHeartbeat';

export class SetChatHeartbeatWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const metadata = (this.state as any)?.metadata as Record<string, any> | undefined;
    const threadId = String(metadata?.threadId || this.executionContext?.thread_id || '').trim();
    if (!threadId) {
      return { successBoolean: false, responseString: 'This tool must be called from a chat thread or delegated agent task.' };
    }

    const executionJobId = String(this.executionContext?.job_id || '').trim();
    const modelDecisionTask = metadata?.modelDecisionTask;
    const taskReference = executionJobId
      ? { jobId: executionJobId, taskIndex: this.executionContext?.task_index }
      : modelDecisionTask?.threadId === threadId
        ? { jobId: String(modelDecisionTask.jobId || '').trim(), taskIndex: modelDecisionTask.taskIndex }
        : undefined;
    let job: Awaited<ReturnType<typeof getJob>>;
    let taskIndex = -1;
    if (taskReference?.jobId) {
      const candidate = await getJob(taskReference.jobId);
      const explicitTaskIndex = Number.isInteger(taskReference.taskIndex) ? Number(taskReference.taskIndex) : undefined;
      const candidateIndex = explicitTaskIndex !== undefined
        ? (explicitTaskIndex >= 0 && candidate?.tasks[explicitTaskIndex]?.threadId === threadId ? explicitTaskIndex : -1)
        : candidate?.tasks.findIndex(task => task.threadId === threadId) ?? -1;
      if (candidate && candidateIndex >= 0) {
        job = candidate;
        taskIndex = candidateIndex;
      }
    }
    // Job/task markers are persisted with a thread and can outlive a delegated
    // run when that thread is reused as a top-level chat. A top-level caller is
    // delegated only while the exact referenced task is still open.
    const isTopLevelChat = metadata?.isSubAgent === false
      && Number(metadata?.subAgentDepth ?? 0) === 0
      && !String(metadata?.managerThreadId ?? '').trim();
    if (isTopLevelChat && job && (!['running', 'parked'].includes(job.status)
        || taskIndex < 0 || !['running', 'parked'].includes(job.tasks[taskIndex]?.status))) {
      job = undefined;
      taskIndex = -1;
    }
    const jobId = job?.jobId ?? '';
    if (job && (!['running', 'parked'].includes(job.status)
        || taskIndex < 0 || !['running', 'parked'].includes(job.tasks[taskIndex]?.status))) {
      return { successBoolean: false, responseString: 'This delegated task is no longer open; its heartbeat cannot be changed.' };
    }

    const service = chatHeartbeatProvider.scheduler();
    await chatHeartbeatProvider.ensureJobLifecycleSubscription();
    // Tool calls can come from hidden or tabbed delegated jobs that have no
    // renderer registration. Keep the scheduler keyed by the backend thread;
    // binding the job identity routes its beats through the parked-job wake path.
    // Register only when something is missing: this tool usually runs inside the
    // very turn a beat woke, and that beat's delivery is still in flight.
    const current = service.status(threadId);
    const registeredTarget = service.jobTarget(threadId);
    const targetMatches = !!jobId && registeredTarget?.jobId === jobId && registeredTarget.taskIndex === taskIndex;
    if (!jobId && registeredTarget) service.unbindJob(threadId);
    if (!current || (jobId && !targetMatches) || (!jobId && registeredTarget)) {
      service.register({
        threadId,
        channel:  job?.parentChannel || String(metadata?.wsChannel || '').trim() || 'sulla-desktop',
        config:   current ?? normalizeChatHeartbeatConfig(null),
        ...(jobId ? { jobId, taskIndex } : {}),
      });
    }

    const rawMinutes = Number(input.intervalMinutes);
    const minimumMinutes = jobId ? CHAT_HEARTBEAT_JOB_MIN_INTERVAL_MINUTES : 1;
    const requestedMinutes = Number.isFinite(rawMinutes) && rawMinutes > 0 ? rawMinutes : null;
    const intervalMinutes = requestedMinutes === null ? null : Math.max(minimumMinutes, requestedMinutes);
    const clampedNotice = requestedMinutes !== null && requestedMinutes < minimumMinutes
      ? ` The requested interval was raised to the ${ minimumMinutes }-minute minimum for ${ jobId ? 'delegated jobs' : 'chats' }.`
      : '';
    const minimumNotice = ` Minimum interval: ${ minimumMinutes } minute(s) for ${ jobId ? 'delegated tasks' : 'chats' }.`;
    const message = typeof input.message === 'string' && input.message.trim()
      ? input.message.trim()
      : current?.message || DEFAULT_CHAT_HEARTBEAT_MESSAGE;
    const status = service.configure(threadId, { intervalMinutes, message, setBy: 'agent' });
    if (jobId) await chatHeartbeatProvider.persistJobHeartbeat(threadId);
    const notice = status?.enabled ? service.activationNotice(threadId) : null;

    return {
      successBoolean: !!status,
      responseString: status?.enabled
        ? `Heartbeat is on every ${ status.intervalMinutes } minute(s).${ minimumNotice }${ clampedNotice }\n\n${ notice }`
        : 'Heartbeat is off.',
    };
  }
}

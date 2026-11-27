// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { chatHeartbeatProvider } from '../../app/Providers/ChatHeartbeatServiceProvider';
import { findTaskByThread, getJob } from '../agents/jobRegistry';
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

    const candidateIds = [...new Set([
      String(this.executionContext?.job_id || '').trim(),
      String(metadata?.modelDecisionTask?.jobId || '').trim(),
      String(metadata?.delegatedJobId || '').trim(),
      String(metadata?.jobId || '').trim(),
    ].filter(Boolean))];
    // A thread is job-bound only through the task that actually owns that thread.
    // Parent links and stale delegated metadata describe launched children, not the caller.
    const owner = candidateIds.length ? await findTaskByThread(threadId) : undefined;
    let job = owner?.job;
    let taskIndex = owner?.taskIndex ?? -1;
    if (!job) {
      for (const candidateId of candidateIds) {
        const candidate = await getJob(candidateId);
        const candidateIndex = candidate?.tasks.findIndex(task => task.threadId === threadId) ?? -1;
        if (candidate && candidateIndex >= 0) {
          job = candidate;
          taskIndex = candidateIndex;
          break;
        }
      }
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

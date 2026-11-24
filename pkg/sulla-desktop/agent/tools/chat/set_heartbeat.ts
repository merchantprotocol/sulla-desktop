// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { chatHeartbeatProvider } from '../../app/Providers/ChatHeartbeatServiceProvider';
import { getJob } from '../agents/jobRegistry';
import { BaseTool, ToolResponse } from '../base';

import { DEFAULT_CHAT_HEARTBEAT_MESSAGE, normalizeChatHeartbeatConfig } from '@pkg/shared/chatHeartbeat';

export class SetChatHeartbeatWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const metadata = (this.state as any)?.metadata as Record<string, any> | undefined;
    const threadId = String(metadata?.threadId || this.executionContext?.thread_id || '').trim();
    if (!threadId) {
      return { successBoolean: false, responseString: 'This tool must be called from a chat thread or delegated agent task.' };
    }

    const contextJobId = String(this.executionContext?.job_id || '').trim();
    const contextTaskIndex = this.executionContext?.task_index;
    const hasContextTarget = !!contextJobId && Number.isInteger(contextTaskIndex) && Number(contextTaskIndex) >= 0;
    const jobId = hasContextTarget ? contextJobId : String(metadata?.delegatedJobId || '').trim();
    const job = jobId ? await getJob(jobId) : undefined;
    const taskIndex = hasContextTarget ? Number(contextTaskIndex) : job?.tasks.findIndex(task => task.threadId === threadId) ?? -1;
    if (jobId && (!job || taskIndex < 0 || !['running', 'parked'].includes(job.status)
        || job.tasks[taskIndex]?.threadId !== threadId || !['running', 'parked'].includes(job.tasks[taskIndex]?.status))) {
      return { successBoolean: false, responseString: 'This delegated task is no longer open; its heartbeat cannot be changed.' };
    }

    const service = chatHeartbeatProvider.scheduler();
    await chatHeartbeatProvider.ensureJobLifecycleSubscription();
    // Tool calls can come from hidden or tabbed delegated jobs that have no
    // renderer registration. Keep the scheduler keyed by the backend thread;
    // binding the job identity routes its beats through the parked-job wake path.
    const current = service.status(threadId);
    service.register({
      threadId,
      channel:  job?.parentChannel || String(metadata?.wsChannel || '').trim() || 'sulla-desktop',
      config:   current ?? normalizeChatHeartbeatConfig(null),
      ...(jobId ? { jobId, taskIndex } : {}),
    });

    const rawMinutes = Number(input.intervalMinutes);
    const minimumMinutes = jobId ? 5 : 1;
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

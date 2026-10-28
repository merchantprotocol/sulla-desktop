// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentJobMessagingModel } from '../../../database/models/AgentJobMessagingModel';
import { getAllJobs } from '../jobRegistry';
import { sendJobMessage } from '../send_job_message';
import { stopAgentJob } from '../stop_agent_job';
import { getDesktopDeviceId } from '@pkg/main/deviceIdentity';

export interface CloudAgentProjection {
  jobId: string;
  taskIndex: number;
  agentId: string;
  label: string;
  state: string;
  currentTask: string | null;
  progress: number | null;
  startedAt: string | null;
  lastActivityAt: string;
  deviceId: string;
}

export async function buildAgentProjection(): Promise<CloudAgentProjection[]> {
  const [deviceId, jobs] = await Promise.all([getDesktopDeviceId(), getAllJobs()]);
  const visible = jobs.filter(job => job.status === 'running');
  const telemetry = await Promise.all(visible.map(job => AgentJobMessagingModel.telemetryForJob(job.jobId)));
  // taskIndex must be the task's real index in the job: stop/message commands address it.
  return visible.flatMap((job, ji) => job.tasks.map((task, taskIndex) => ({ task, taskIndex }))
    .filter(({ task }) => task.status === 'queued' || task.status === 'running').map(({ task, taskIndex }) => {
    const checkin = telemetry[ji][taskIndex]?.latestCheckin;
    return {
      jobId: job.jobId, taskIndex, agentId: task.agentId, label: task.label,
      state: task.status, currentTask: checkin?.summary?.slice(0, 500) ?? null,
      progress: typeof checkin?.percent === 'number' ? checkin.percent : null,
      startedAt: task.startedAt ? new Date(task.startedAt).toISOString() : null,
      lastActivityAt: new Date(checkin?.createdAt ?? task.startedAt ?? job.createdAt).toISOString(), deviceId,
    };
  }));
}

export async function pushAgentProjection(upload: (path: string, body: unknown) => Promise<void>): Promise<void> {
  const [deviceId, agents] = await Promise.all([getDesktopDeviceId(), buildAgentProjection()]);
  await upload('/cloud-runtime/v1/device/agents', { deviceId, generatedAt: new Date().toISOString(), agents });
}

/** Dispatch only after SecureDesktopChannel verified the browser signature and device id. */
export async function dispatchCloudAgentCommand(body: Record<string, any>): Promise<Record<string, unknown>> {
  const jobId = typeof body.jobId === 'string' ? body.jobId : '';
  const taskIndex = Number(body.taskIndex);
  const job = (await getAllJobs()).find(candidate => candidate.jobId === jobId);
  // Ownership boundary: only a job and task currently projected by this Desktop
  // may be controlled. Never let a signed client address arbitrary local jobs.
  const live = (status: string) => ['queued', 'running'].includes(status);
  // A stop may target the whole job; a message always targets one task.
  const targeted = body.taskIndex !== undefined || body.type === 'agent.message';
  if (!job || (targeted
    ? !Number.isInteger(taskIndex) || !job.tasks[taskIndex] || !live(job.tasks[taskIndex].status)
    : !job.tasks.some(task => live(task.status)))) {
    return { ok: false, error: 'agent_not_found' };
  }
  if (body.type === 'agent.stop') {
    const result = await stopAgentJob(jobId);
    return { ok: result.successBoolean, message: result.responseString };
  }
  if (body.type === 'agent.message') {
    const message = typeof body.message === 'string' ? body.message.trim().slice(0, 4_000) : '';
    if (!message) return { ok: false, error: 'message_required' };
    const result = await sendJobMessage({ jobId, taskIndex, message });
    return { ok: result.successBoolean, message: result.responseString };
  }
  return { ok: false, error: 'unsupported_cloud_agent_command' };
}

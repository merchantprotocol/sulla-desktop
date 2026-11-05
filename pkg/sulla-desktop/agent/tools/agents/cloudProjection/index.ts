// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { agentJobProvider } from '../../../app/Providers/AgentJobServiceProvider';
import { AgentStateProjector } from '../../../app/Services/AgentStateProjector';
import { sendJobMessage } from '../send_job_message';
import { stopAgentJob } from '../stop_agent_job';
import { getDesktopDeviceId } from '@pkg/main/deviceIdentity';
import { StopPrincipal } from '@pkg/agent/app/ValueObjects/StopPrincipal';

export interface CloudAgentProjection {
  jobId: string; taskIndex: number; agentId: string; label: string; state: string;
  currentTask: string | null; progress: number | null; startedAt: string | null;
  lastActivityAt: string; deviceId: string;
}

export class CloudAgentStateProjection {
  private readonly projector = new AgentStateProjector(agentJobProvider.states, {
    latest: async(jobId, taskIndex) => (await agentJobProvider.messaging.telemetryForJob(jobId))[taskIndex]?.latestCheckin ?? null,
  });

  async build(deviceId = ''): Promise<CloudAgentProjection[]> {
    const snapshot = await this.projector.snapshot();
    return snapshot.rows.filter(row => ['queued', 'working', 'parked', 'quiet', 'blocked'].includes(row.state)).map(row => ({
      jobId: row.jobId, taskIndex: row.taskIndex, agentId: row.agentId ?? '', label: row.label,
      state: row.state, currentTask: row.lastCheckinSummary, progress: null, startedAt: row.startedAt,
      lastActivityAt: row.lastCheckinAt ?? row.startedAt ?? snapshot.generatedAt, deviceId,
    }));
  }

  async dispatch(body: Record<string, any>): Promise<Record<string, unknown>> {
    const jobId = typeof body.jobId === 'string' ? body.jobId : '';
    const taskIndex = Number(body.taskIndex);
    const job = await agentJobProvider.states.job(jobId);
    const targeted = body.taskIndex !== undefined || body.type === 'agent.message';
    if (!job || (targeted
      ? !Number.isInteger(taskIndex) || !job.tasks[taskIndex] || !agentJobProvider.states.isLive(job, job.tasks[taskIndex])
      : !job.tasks.some(task => agentJobProvider.states.isLive(job, task)))) return { ok: false, error: 'agent_not_found' };
    if (body.type === 'agent.stop') {
      const result = await stopAgentJob(jobId, StopPrincipal.system('cloud-runtime'), 'Stopped from cloud runtime');
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
}

const cloudProjection = new CloudAgentStateProjection();
export async function buildAgentProjection(): Promise<CloudAgentProjection[]> {
  return cloudProjection.build(await getDesktopDeviceId());
}
export async function pushAgentProjection(upload: (path: string, body: unknown) => Promise<void>): Promise<void> {
  const deviceId = await getDesktopDeviceId();
  const agents = await cloudProjection.build(deviceId);
  await upload('/cloud-runtime/v1/device/agents', { deviceId, generatedAt: new Date().toISOString(), agents });
}
export async function dispatchCloudAgentCommand(body: Record<string, any>): Promise<Record<string, unknown>> {
  return cloudProjection.dispatch(body);
}

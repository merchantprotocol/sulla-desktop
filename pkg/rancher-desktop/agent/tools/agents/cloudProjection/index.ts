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
  return visible.flatMap((job, ji) => job.tasks.filter(task => task.status === 'queued' || task.status === 'running').map((task, taskIndex) => {
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
  await upload('/cloud-runtime/v1/device/agents', { agents: await buildAgentProjection() });
}

/** Dispatch only after SecureDesktopChannel verified the browser signature and device id. */
export async function dispatchCloudAgentCommand(body: Record<string, any>): Promise<Record<string, unknown>> {
  if (body.type === 'agent.stop') {
    const result = await stopAgentJob(String(body.jobId ?? ''));
    return { ok: result.successBoolean, message: result.responseString };
  }
  if (body.type === 'agent.message') {
    const result = await sendJobMessage({
      jobId: String(body.jobId ?? ''),
      taskIndex: body.taskIndex === undefined ? undefined : Number(body.taskIndex),
      message: String(body.message ?? '').slice(0, 4_000),
    });
    return { ok: result.successBoolean, message: result.responseString };
  }
  return { ok: false, error: 'unsupported_cloud_agent_command' };
}

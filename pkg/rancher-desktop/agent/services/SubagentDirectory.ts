/**
 * The per-turn <subagent_directory> block: every child this thread launched,
 * hidden or tab, with its progress. SubconsciousMiddleware builds it before
 * each turn (a human message or a result wake) for any agent with children.
 *
 * Mechanical read, no LLM call: the job rows for this parent thread, their
 * latest check-ins and the run-activity clock. One line per child, then any
 * result that has not reached the parent yet, then a nudge when an open child
 * has gone quiet.
 */

import { AgentJobMessagingModel, type AgentJobTaskTelemetry } from '../database/models/AgentJobMessagingModel';
import { getJobsForParentThread, type AgentJob, type AgentJobTask } from '../tools/agents/jobRegistry';
import { RunActivity } from './RunActivity';

/** An open child silent this long is flagged as stalled. */
export const SUBAGENT_STALL_MS = 15 * 60_000;
/** A delivered, finished child stays listed this long, then drops off. */
export const SUBAGENT_DONE_TTL_MS = 60 * 60_000;
export const SUBAGENT_DIRECTORY_MAX_CHARS = 3000;

function ago(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${ minutes }m ago`;
  const hours = Math.floor(minutes / 60);
  return `${ hours }h ${ minutes % 60 }m ago`;
}

function span(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${ minutes }m`;
  return `${ Math.floor(minutes / 60) }h ${ minutes % 60 }m`;
}

function quote(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return `"${ flat.length > max ? `${ flat.slice(0, max) }…` : flat }"`;
}

function isOpen(job: AgentJob, task: AgentJobTask): boolean {
  return job.status === 'running' && (task.status === 'running' || task.status === 'queued');
}

interface ChildRow {
  line:        string;
  stalled:     boolean;
  undelivered: boolean;
}

function describe(job: AgentJob, task: AgentJobTask, taskIndex: number, telemetry: AgentJobTaskTelemetry | undefined, now: number): ChildRow | null {
  if (task.dismissed) return null;
  const finishedAt = task.finishedAt ?? job.finishedAt ?? undefined;
  const open = isOpen(job, task);
  // Delivered and finished an hour ago: the parent already has it.
  if (!open && job.completionDeliveredAt && finishedAt && now - finishedAt > SUBAGENT_DONE_TTL_MS) return null;

  const visibility = task.visibility ?? job.visibility ?? 'hidden';
  const startedAt = task.startedAt ?? job.createdAt;
  const checkin = telemetry?.latestCheckin ?? null;
  const lastActivity = Math.max(
    RunActivity.lastActivityAt(job.jobId) ?? 0,
    checkin?.createdAt ?? 0,
    startedAt,
  );
  const stalled = open && now - lastActivity >= SUBAGENT_STALL_MS;
  const ref = job.tasks.length > 1 ? `${ job.jobId }#${ taskIndex }` : job.jobId;

  const parts = [
    task.agentId,
    task.promotedToTab ? 'hidden→tab' : visibility,
    open
      ? `${ task.status === 'queued' ? 'queued' : 'running' } ${ span(now - startedAt) }`
      : `${ task.returnedAt ? 'returned' : task.status } ${ finishedAt ? ago(now - finishedAt) : '' }`.trim(),
    `contract ${ task.contract?.name ?? 'result' }`,
  ];
  if (checkin) {
    parts.push(`last check-in ${ ago(now - checkin.createdAt) }${ checkin.percent === undefined ? '' : ` ${ checkin.percent }%` } ${ quote(checkin.summary) }`);
  } else if (open) {
    parts.push('no check-in yet');
  }
  if (checkin?.blockers.length) parts.push(`blockers: ${ quote(checkin.blockers.join('; ')) }`);
  if (stalled) parts.push(`⚠ stalled (quiet ${ span(now - lastActivity) })`);
  parts.push(`job ${ ref }`);

  const undelivered = !open && job.status === 'completed' && !job.completionDeliveredAt;
  return { line: `- ${ parts.join(' · ') }`, stalled, undelivered };
}

/** The block body for a parent thread, or '' when it has no listed children. */
export async function buildSubagentDirectoryContext(parentThreadId: string | undefined, now = Date.now()): Promise<string> {
  if (!parentThreadId) return '';
  const jobs = await getJobsForParentThread(parentThreadId);
  if (jobs.length === 0) return '';

  const rows: ChildRow[] = [];
  const pending: string[] = [];
  for (const job of jobs) {
    const telemetry = await AgentJobMessagingModel.telemetryForJob(job.jobId).catch(() => ({} as Record<number, AgentJobTaskTelemetry>));
    job.tasks.forEach((task, index) => {
      const row = describe(job, task, index, telemetry[index], now);
      if (!row) return;
      rows.push(row);
      if (row.undelivered) pending.push(`- ${ task.label || task.agentId } (job ${ job.jobId }): ${ quote(job.results[index]?.output ?? task.summary ?? '', 160) }`);
    });
  }
  if (rows.length === 0) return '';

  const out = [
    '## Your subagents',
    'Children launched from this conversation (hidden and tab). Control them with agents/check_agent_jobs, agents/send_job_message, agents/stop_agent_job.',
  ];
  let size = out.join('\n').length;
  for (const [index, row] of rows.entries()) {
    if (size + row.line.length + 1 > SUBAGENT_DIRECTORY_MAX_CHARS) {
      out.push(`- …${ rows.length - index } more: \`sulla agents/check_agent_jobs\``);
      break;
    }
    out.push(row.line);
    size += row.line.length + 1;
  }
  if (pending.length) {
    out.push('', '### Results not yet processed', 'These returned but have not reached you as a wake yet. Use them now:', ...pending);
  }
  const stalled = rows.filter(row => row.stalled).length;
  if (stalled) {
    out.push('', `⚠ ${ stalled } open child${ stalled === 1 ? ' looks' : 'ren look' } stalled (no activity for 15+ min). Check it, message it, or stop and relaunch it this turn.`);
  }
  return out.join('\n');
}

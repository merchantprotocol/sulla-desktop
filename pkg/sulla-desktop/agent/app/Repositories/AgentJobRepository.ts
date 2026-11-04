// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { Repository } from '@sulla/foundation';

import { AgentJob as AgentJobModel } from '../Models/AgentJob';
import type { AgentJob, AgentJobResult, AgentJobTask } from '../../tools/agents/jobRegistry';

export class AgentJobRepository extends Repository<AgentJobModel> {
  protected readonly model = AgentJobModel;

  map(row: Record<string, any>): AgentJob {
    return {
      jobId: row.job_id, status: row.status, createdAt: new Date(row.created_at).getTime(),
      finishedAt: row.finished_at ? new Date(row.finished_at).getTime() : null,
      taskCount: Number(row.task_count) || 0, results: Array.isArray(row.results) ? row.results : [],
      tasks: Array.isArray(row.tasks) ? row.tasks : [], error: row.error ?? undefined,
      parentChannel: row.parent_channel ?? undefined, parentThreadId: row.parent_thread_id ?? undefined,
      parentAgentId: row.parent_agent_id ?? undefined, visibility: row.visibility === 'tab' ? 'tab' : 'hidden',
      projectTaskIds: Array.isArray(row.project_task_ids) ? row.project_task_ids : [],
      completionDeliveredAt: row.completion_delivered_at ? new Date(row.completion_delivered_at).getTime() : null,
      dismissedAt: row.dismissed_at ? new Date(row.dismissed_at).getTime() : null,
    };
  }

  async sweepInterruptedJobs(): Promise<void> {
    await this.connection.run(`UPDATE agent_jobs SET status = 'failed', error = 'app restarted mid-job', finished_at = now() WHERE status = 'running' AND visibility <> 'tab'`);
  }

  async insertJob(job: AgentJob): Promise<void> {
    await this.connection.run(`INSERT INTO agent_jobs (job_id, status, task_count, parent_channel, parent_thread_id, created_at, tasks, visibility, parent_agent_id) VALUES ($1, 'running', $2, $4, $5, to_timestamp($3 / 1000.0), $6::jsonb, $7, $8) ON CONFLICT (job_id) DO NOTHING`,
      [job.jobId, job.taskCount, job.createdAt, job.parentChannel ?? null, job.parentThreadId ?? null, JSON.stringify(job.tasks), job.visibility ?? 'hidden', job.parentAgentId ?? null]);
  }

  async updateTasks(jobId: string, tasks: AgentJobTask[]): Promise<void> {
    await this.connection.run(`UPDATE agent_jobs SET tasks = $2::jsonb WHERE job_id = $1`, [jobId, JSON.stringify(tasks)]);
  }

  async jobsForParentThread(parentThreadId: string): Promise<AgentJob[]> {
    const rows = await this.connection.select(`SELECT * FROM agent_jobs WHERE parent_thread_id = $1 AND dismissed_at IS NULL ORDER BY created_at ASC`, [parentThreadId]);
    return rows.map(row => this.map(row));
  }

  async dismissTasks(jobId: string, parentThreadId: string, tasks: AgentJobTask[], allDismissed: boolean): Promise<void> {
    await this.connection.run(`UPDATE agent_jobs SET tasks = $3::jsonb, dismissed_at = CASE WHEN $4 THEN now() ELSE dismissed_at END WHERE job_id = $1 AND parent_thread_id = $2`, [jobId, parentThreadId, JSON.stringify(tasks), allDismissed]);
  }

  async stop(jobId: string, tasks: AgentJobTask[]): Promise<void> {
    await this.connection.run(`UPDATE agent_jobs SET status = 'stopped', finished_at = now(), tasks = $2::jsonb WHERE job_id = $1`, [jobId, JSON.stringify(tasks)]);
  }

  async job(jobId: string): Promise<AgentJob | undefined> {
    const row = await this.connection.first(`SELECT * FROM agent_jobs WHERE job_id = $1`, [jobId]);
    return row ? this.map(row) : undefined;
  }

  async allJobs(): Promise<AgentJob[]> {
    return (await this.query().unsafeAll().get()).map(row => this.map(row));
  }

  async jobsForList(limit: number, includeFinished: boolean): Promise<AgentJob[]> {
    const rows = await this.connection.select(`WITH selected AS (
      SELECT * FROM agent_jobs WHERE status = 'running' AND dismissed_at IS NULL
      UNION ALL
      (SELECT * FROM agent_jobs WHERE status <> 'running' AND dismissed_at IS NULL AND $2::boolean ORDER BY created_at DESC LIMIT $1)
    ) SELECT job_id, status, created_at, finished_at, task_count, error, parent_channel, parent_thread_id,
      parent_agent_id, visibility, project_task_ids, completion_delivered_at, dismissed_at, '[]'::jsonb AS results,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('agentId', task->>'agentId', 'label', task->>'label',
      'taskId', task->>'taskId', 'status', task->>'status', 'visibility', task->>'visibility',
      'startedAt', task->'startedAt', 'finishedAt', task->'finishedAt', 'returnedAt', task->'returnedAt',
      'contract', CASE WHEN task ? 'contract' THEN jsonb_build_object('name', task->'contract'->>'name') ELSE NULL END))
      FROM jsonb_array_elements(selected.tasks) AS task), '[]'::jsonb) AS tasks
      FROM selected ORDER BY created_at DESC`, [limit, includeFinished]);
    return rows.map(row => this.map(row));
  }

  async saveStoppedResults(jobId: string, results: AgentJobResult[], tasks: AgentJobTask[]): Promise<void> {
    await this.connection.run(`UPDATE agent_jobs SET results = $2::jsonb, tasks = $3::jsonb WHERE job_id = $1`, [jobId, JSON.stringify(results), JSON.stringify(tasks)]);
  }

  async complete(job: AgentJob): Promise<void> {
    await this.connection.run(`UPDATE agent_jobs SET status = $2, finished_at = now(), error = $3, results = $4::jsonb, tasks = $5::jsonb, completion_delivered_at = NULL WHERE job_id = $1`, [job.jobId, job.status, job.error ?? null, JSON.stringify(job.results), JSON.stringify(job.tasks)]);
  }

  async markCompletionDelivered(jobId: string): Promise<void> {
    await this.connection.run(`UPDATE agent_jobs SET completion_delivered_at = now() WHERE job_id = $1 AND status = 'completed' AND completion_delivered_at IS NULL`, [jobId]);
  }

  async pendingCompletions(): Promise<AgentJob[]> {
    const rows = await this.connection.select(`SELECT * FROM agent_jobs WHERE status = 'completed' AND completion_delivered_at IS NULL AND parent_channel IS NOT NULL AND parent_thread_id IS NOT NULL ORDER BY finished_at ASC`);
    return rows.map(row => this.map(row));
  }

  async findByTaskThread(threadId: string): Promise<AgentJob | undefined> {
    const row = await this.connection.first(`SELECT * FROM agent_jobs WHERE tasks @> jsonb_build_array(jsonb_build_object('threadId', $1::text)) ORDER BY created_at DESC LIMIT 1`, [threadId]);
    return row ? this.map(row) : undefined;
  }

  async fail(jobId: string, error: string, tasks: AgentJobTask[]): Promise<void> {
    await this.connection.run(`UPDATE agent_jobs SET status = 'failed', finished_at = now(), error = $2, tasks = $3::jsonb WHERE job_id = $1`, [jobId, error, JSON.stringify(tasks)]);
  }

  async hasQueuedOrRunningChildren(job: AgentJob): Promise<boolean> {
    const threadIds = job.tasks.map(task => task.threadId).filter((threadId): threadId is string => Boolean(threadId));
    if (threadIds.length === 0) return false;
    const row = await this.connection.first(`SELECT EXISTS (
      SELECT 1 FROM agent_jobs child
      WHERE child.parent_thread_id = ANY($1::text[])
        AND (child.status = 'running' OR child.tasks @? '$[*] ? (@.status == "queued" || @.status == "running")')
    ) AS present`, [threadIds]);
    return row?.present === true || row?.present === 't';
  }

  async deleteJob(jobId: string): Promise<void> { await this.query().where('job_id', jobId).delete(); }
}

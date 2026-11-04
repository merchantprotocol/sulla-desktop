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
      waitingOnChildren: Number(row.waiting_on_children) || 0,
      restartResumeCount: Number(row.restart_resume_count) || 0,
      dismissedAt: row.dismissed_at ? new Date(row.dismissed_at).getTime() : null,
    };
  }

  /** Claim non-terminal hidden jobs for bounded restart recovery; never blanket-fail live work. */
  async claimInterruptedJobs(maxResumes = 2): Promise<{ resumable: AgentJob[]; exhausted: AgentJob[] }> {
    const exhaustedRows = await this.connection.select(`UPDATE agent_jobs SET status = 'failed', error = 'runtime restart recovery limit exceeded', finished_at = now(), waiting_on_children = 0
      WHERE status = 'running' AND visibility <> 'tab' AND restart_resume_count >= $1 RETURNING *`, [maxResumes]);
    const resumableRows = await this.connection.select(`UPDATE agent_jobs SET restart_resume_count = restart_resume_count + 1
      WHERE status = 'running' AND visibility <> 'tab' AND restart_resume_count < $1 RETURNING *`, [maxResumes]);
    return { resumable: resumableRows.map(row => this.map(row)), exhausted: exhaustedRows.map(row => this.map(row)) };
  }

  async sweepInterruptedJobs(): Promise<void> { /* recovery is driven by claimInterruptedJobs after channels subscribe */ }


  async insertJob(job: AgentJob): Promise<void> {
    await this.connection.run(`INSERT INTO agent_jobs (job_id, status, task_count, parent_channel, parent_thread_id, created_at, tasks, visibility, parent_agent_id) VALUES ($1, 'running', $2, $4, $5, to_timestamp($3 / 1000.0), $6::jsonb, $7, $8) ON CONFLICT (job_id) DO NOTHING`,
      [job.jobId, job.taskCount, job.createdAt, job.parentChannel ?? null, job.parentThreadId ?? null, JSON.stringify(job.tasks), job.visibility ?? 'hidden', job.parentAgentId ?? null]);
  }

  async replaceState(job: AgentJob): Promise<void> {
    await this.connection.run(`UPDATE agent_jobs SET status = $2, tasks = $3::jsonb, results = $4::jsonb,
      error = $5, finished_at = CASE WHEN $6::bigint IS NULL THEN NULL ELSE to_timestamp($6 / 1000.0) END,
      waiting_on_children = $7 WHERE job_id = $1`, [job.jobId, job.status, JSON.stringify(job.tasks),
      JSON.stringify(job.results), job.error ?? null, job.finishedAt, job.waitingOnChildren ?? 0]);
  }

  async updateTasks(jobId: string, tasks: AgentJobTask[]): Promise<void> {
    await this.connection.run(`UPDATE agent_jobs SET tasks = $2::jsonb WHERE job_id = $1 AND status IN ('running', 'parked')`, [jobId, JSON.stringify(tasks)]);
  }

  async updateTaskCompletions(jobId: string, tasks: AgentJobTask[], results: AgentJobResult[]): Promise<void> {
    await this.connection.run(`UPDATE agent_jobs SET tasks = $2::jsonb, results = $3::jsonb WHERE job_id = $1`, [jobId, JSON.stringify(tasks), JSON.stringify(results)]);
  }

  async jobsForParentThread(parentThreadId: string): Promise<AgentJob[]> {
    const rows = await this.connection.select(`SELECT * FROM agent_jobs WHERE parent_thread_id = $1 AND dismissed_at IS NULL ORDER BY created_at ASC`, [parentThreadId]);
    return rows.map(row => this.map(row));
  }

  async dismissTasks(jobId: string, parentThreadId: string, tasks: AgentJobTask[], allDismissed: boolean): Promise<void> {
    await this.connection.run(`UPDATE agent_jobs SET tasks = $3::jsonb, dismissed_at = CASE WHEN $4 THEN now() ELSE dismissed_at END WHERE job_id = $1 AND parent_thread_id = $2`, [jobId, parentThreadId, JSON.stringify(tasks), allDismissed]);
  }

  async stop(jobId: string, tasks: AgentJobTask[]): Promise<void> {
    await this.connection.run(`UPDATE agent_jobs SET status = 'stopped', finished_at = now(), waiting_on_children = 0, tasks = $2::jsonb WHERE job_id = $1 AND status IN ('running', 'parked')`, [jobId, JSON.stringify(tasks)]);
  }

  async stopCascade(jobId: string): Promise<string[]> {
    const rows = await this.connection.select(`WITH RECURSIVE descendants AS (
      SELECT job_id, tasks FROM agent_jobs WHERE job_id = $1
      UNION ALL
      SELECT child.job_id, child.tasks FROM agent_jobs child
      JOIN descendants parent ON child.parent_thread_id IN (SELECT value->>'threadId' FROM jsonb_array_elements(parent.tasks) value)
    )
    UPDATE agent_jobs target SET status = 'stopped', finished_at = now(), waiting_on_children = 0,
      tasks = (SELECT COALESCE(jsonb_agg(CASE WHEN value->>'status' IN ('queued','running','parked') THEN value || jsonb_build_object('status','stopped','finishedAt',(extract(epoch from now())*1000)::bigint) ELSE value END), '[]'::jsonb) FROM jsonb_array_elements(target.tasks) value)
    FROM descendants WHERE target.job_id = descendants.job_id AND target.status IN ('running','parked') RETURNING target.job_id` , [jobId]);
    return rows.map(row => String(row.job_id));
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
      SELECT * FROM agent_jobs WHERE status IN ('running', 'parked') AND dismissed_at IS NULL
      UNION ALL
      (SELECT * FROM agent_jobs WHERE status NOT IN ('running', 'parked') AND dismissed_at IS NULL AND $2::boolean ORDER BY created_at DESC LIMIT $1)
    ) SELECT job_id, status, created_at, finished_at, task_count, error, parent_channel, parent_thread_id,
      parent_agent_id, visibility, project_task_ids, completion_delivered_at, dismissed_at, waiting_on_children, '[]'::jsonb AS results,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('agentId', task->>'agentId', 'label', task->>'label',
      'taskId', task->>'taskId', 'status', task->>'status', 'visibility', task->>'visibility',
      'startedAt', task->'startedAt', 'finishedAt', task->'finishedAt', 'returnedAt', task->'returnedAt',
      'contract', CASE WHEN task ? 'contract' THEN jsonb_build_object('name', task->'contract'->>'name') ELSE NULL END))
      FROM jsonb_array_elements(selected.tasks) AS task), '[]'::jsonb) AS tasks
      FROM selected ORDER BY created_at DESC`, [limit, includeFinished]);
    return rows.map(row => this.map(row));
  }

  /**
   * `status` is the job-level rollup the caller computed from every task's
   * own status (running if any sibling is still running/queued, else
   * parked) — a second task in the same job can park after the first
   * without the job row already being 'parked' blocking the write.
   */
  async park(jobId: string, tasks: AgentJobTask[], waitingOnChildren: number, status: 'running' | 'parked'): Promise<void> {
    await this.connection.run(`UPDATE agent_jobs SET status = $4, tasks = $2::jsonb, waiting_on_children = $3 WHERE job_id = $1 AND status IN ('running', 'parked')`, [jobId, JSON.stringify(tasks), waitingOnChildren, status]);
  }

  async resume(jobId: string, tasks: AgentJobTask[]): Promise<void> {
    await this.connection.run(`UPDATE agent_jobs SET status = 'running', tasks = $2::jsonb, waiting_on_children = 0 WHERE job_id = $1 AND status IN ('running', 'parked')`, [jobId, JSON.stringify(tasks)]);
  }

  async openChildrenForThread(threadId: string): Promise<number> {
    const row = await this.connection.first(`SELECT count(*)::int AS count FROM agent_jobs WHERE parent_thread_id = $1 AND status IN ('running', 'parked')`, [threadId]);
    return Number(row?.count) || 0;
  }

  async saveStoppedResults(jobId: string, results: AgentJobResult[], tasks: AgentJobTask[]): Promise<void> {
    await this.connection.run(`UPDATE agent_jobs SET results = $2::jsonb, tasks = $3::jsonb WHERE job_id = $1`, [jobId, JSON.stringify(results), JSON.stringify(tasks)]);
  }

  async complete(job: AgentJob): Promise<void> {
    await this.connection.run(`UPDATE agent_jobs SET status = $2, finished_at = now(), waiting_on_children = 0, error = $3, results = $4::jsonb, tasks = $5::jsonb WHERE job_id = $1`, [job.jobId, job.status, job.error ?? null, JSON.stringify(job.results), JSON.stringify(job.tasks)]);
  }

  async markCompletionDelivered(jobId: string): Promise<void> {
    await this.connection.run(`UPDATE agent_jobs SET completion_delivered_at = now() WHERE job_id = $1 AND status = 'completed' AND completion_delivered_at IS NULL`, [jobId]);
  }

  async pendingCompletions(): Promise<AgentJob[]> {
    const rows = await this.connection.select(`SELECT * FROM agent_jobs WHERE (tasks @? '$[*] ? (@.completion != null)' OR (status = 'completed' AND completion_delivered_at IS NULL)) AND parent_channel IS NOT NULL AND parent_thread_id IS NOT NULL ORDER BY COALESCE(finished_at, created_at) ASC`);
    return rows.map(row => this.map(row));
  }

  async findByTaskThread(threadId: string): Promise<AgentJob | undefined> {
    const row = await this.connection.first(`SELECT * FROM agent_jobs WHERE tasks @> jsonb_build_array(jsonb_build_object('threadId', $1::text)) ORDER BY created_at DESC LIMIT 1`, [threadId]);
    return row ? this.map(row) : undefined;
  }

  async fail(jobId: string, error: string, tasks: AgentJobTask[]): Promise<void> {
    await this.connection.run(`UPDATE agent_jobs SET status = 'failed', finished_at = now(), waiting_on_children = 0, error = $2, tasks = $3::jsonb WHERE job_id = $1 AND status IN ('running', 'parked')`, [jobId, error, JSON.stringify(tasks)]);
  }

  async hasQueuedOrRunningChildren(job: AgentJob): Promise<boolean> {
    const threadIds = job.tasks.map(task => task.threadId).filter((threadId): threadId is string => Boolean(threadId));
    if (threadIds.length === 0) return false;
    const row = await this.connection.first(`SELECT EXISTS (
      SELECT 1 FROM agent_jobs child
      WHERE child.parent_thread_id IN (SELECT jsonb_array_elements_text($1::jsonb))
        AND (child.status = 'running' OR child.tasks @? '$[*] ? (@.status == "queued" || @.status == "running")')
    ) AS present`, [JSON.stringify(threadIds)]);
    return row?.present === true || row?.present === 't';
  }

  async deleteJob(jobId: string): Promise<void> { await this.query().where('job_id', jobId).delete(); }
}

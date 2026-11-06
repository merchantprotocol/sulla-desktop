// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { randomUUID } from 'node:crypto';

import { Repository } from '@sulla/foundation';

import { AgentJob as AgentJobModel } from '../Models/AgentJob';
import type { AgentJob, AgentJobResult, AgentJobTask, OrphanedChildNotice } from '../../tools/agents/jobRegistry';

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
      stoppedBy: row.stopped_by === 'human' ? 'human' : (row.stopped_by?.system
        ? { system: String(row.stopped_by.system) }
        : row.stopped_by ? { agentId: String(row.stopped_by.agentId), threadId: String(row.stopped_by.threadId) } : undefined),
      stopReason: row.stop_reason ?? undefined,
      orphanedChildNotices: Array.isArray(row.orphaned_child_notices) ? row.orphaned_child_notices : [],
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

  async updateTasks(jobId: string, tasks: AgentJobTask[]): Promise<void> {
    await this.connection.run(`UPDATE agent_jobs SET tasks = $2::jsonb WHERE job_id = $1 AND status IN ('running', 'parked')`, [jobId, JSON.stringify(tasks)]);
  }

  /** Acknowledge one consumed task without reopening terminal rows to general task mutation. */
  async markTaskCompletionDelivered(jobId: string, taskIndex: number, deliveredAt: number): Promise<void> {
    await this.connection.run(`UPDATE agent_jobs
      SET tasks = jsonb_set(tasks, ARRAY[$2::text, 'completionDeliveredAt'], to_jsonb($3::bigint), true)
      WHERE job_id = $1
        AND (tasks -> $2::int) IS NOT NULL
        AND (tasks -> $2::int) ->> 'completionDeliveredAt' IS NULL`, [jobId, taskIndex, deliveredAt]);
  }

  async updateTaskCompletions(jobId: string, taskIndex: number, tasks: AgentJobTask[], results: AgentJobResult[]): Promise<void> {
    const task = tasks[taskIndex];
    const generation = task?.generation ?? 1;
    await this.connection.run(`WITH history AS (
      INSERT INTO agent_job_result_history
        (job_id, task_index, generation, task_status, result, completion, summary, returned_at, finished_at, completion_delivered_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7,
        CASE WHEN $8::bigint IS NULL THEN NULL ELSE to_timestamp($8 / 1000.0) END,
        CASE WHEN $9::bigint IS NULL THEN NULL ELSE to_timestamp($9 / 1000.0) END,
        CASE WHEN $10::bigint IS NULL THEN NULL ELSE to_timestamp($10 / 1000.0) END)
      ON CONFLICT (job_id, task_index, generation) DO NOTHING
    ) UPDATE agent_jobs SET tasks = $11::jsonb, results = $12::jsonb WHERE job_id = $1`,
    [jobId, taskIndex, generation, task?.status ?? 'error', JSON.stringify(task?.result ?? null),
      JSON.stringify(task?.completion ?? results[taskIndex] ?? null), task?.summary ?? null, task?.returnedAt ?? null,
      task?.finishedAt ?? null, task?.completionDeliveredAt ?? null, JSON.stringify(tasks), JSON.stringify(results)]);
  }

  /** Atomically archive the settled generation and claim exactly one reopened generation. */
  async claimReopen(jobId: string, taskIndex: number, expectedGeneration: number): Promise<{ generation: number; leaseId: string } | undefined> {
    const leaseId = randomUUID();
    // Seed legacy generation state separately. PostgreSQL data-modifying CTEs
    // share one snapshot, so an UPDATE cannot see a row inserted by a sibling
    // CTE in the same statement. This insert is idempotent and changes no claim.
    await this.connection.run(`INSERT INTO agent_job_task_reopens (job_id, task_index, generation, reopen_count)
      SELECT $1, $2, COALESCE((tasks -> $2::int ->> 'generation')::int, 1),
        COALESCE((tasks -> $2::int ->> 'reopenCount')::int, 0)
      FROM agent_jobs WHERE job_id = $1 AND (tasks -> $2::int) IS NOT NULL
      ON CONFLICT (job_id, task_index) DO NOTHING`, [jobId, taskIndex]);
    const rows = await this.connection.select(`WITH current_task AS (
      SELECT job_id, tasks -> $2::int AS task
      FROM agent_jobs WHERE job_id = $1 FOR UPDATE
    ), eligible AS (
      SELECT current_task.task, state.generation, state.reopen_count
      FROM current_task JOIN agent_job_task_reopens state ON state.job_id = $1 AND state.task_index = $2
      WHERE current_task.task->>'status' IN ('completed', 'blocked')
        AND state.generation = $3 AND state.reopen_count < 5 AND state.lease_id IS NULL
    ), history AS (
      INSERT INTO agent_job_result_history
        (job_id, task_index, generation, task_status, result, completion, summary, returned_at, finished_at, completion_delivered_at)
      SELECT $1, $2, generation, task->>'status', task->'result', task->'completion', task->>'summary',
        CASE WHEN task->>'returnedAt' IS NULL THEN NULL ELSE to_timestamp((task->>'returnedAt')::bigint / 1000.0) END,
        CASE WHEN task->>'finishedAt' IS NULL THEN NULL ELSE to_timestamp((task->>'finishedAt')::bigint / 1000.0) END,
        CASE WHEN task->>'completionDeliveredAt' IS NULL THEN NULL ELSE to_timestamp((task->>'completionDeliveredAt')::bigint / 1000.0) END
      FROM eligible ON CONFLICT (job_id, task_index, generation) DO NOTHING RETURNING generation
    ), claimed AS (
      UPDATE agent_job_task_reopens r SET generation = r.generation + 1, reopen_count = r.reopen_count + 1,
        lease_id = $4, lease_acquired_at = now(), updated_at = now()
      FROM eligible WHERE r.job_id = $1 AND r.task_index = $2 AND r.generation = $3 AND r.lease_id IS NULL
      RETURNING r.generation, r.reopen_count, r.lease_id
    ) UPDATE agent_jobs j SET status = 'running', finished_at = NULL, completion_delivered_at = NULL,
      tasks = jsonb_set(j.tasks, ARRAY[$2::text],
        ((j.tasks -> $2::int) - 'result' - 'summary' - 'returnedAt' - 'completion' - 'completionDeliveredAt' - 'finishedAt') ||
        jsonb_build_object('status', 'running', 'generation', claimed.generation, 'reopenCount', claimed.reopen_count, 'reopenLeaseId', claimed.lease_id), false)
      FROM claimed WHERE j.job_id = $1 RETURNING claimed.generation, claimed.lease_id`, [jobId, taskIndex, expectedGeneration, leaseId]);
    return rows[0] ? { generation: Number(rows[0].generation), leaseId: String(rows[0].lease_id) } : undefined;
  }

  async releaseReopenLease(jobId: string, taskIndex: number, generation: number, leaseId: string): Promise<boolean> {
    const row = await this.connection.first(`WITH released AS (
      UPDATE agent_job_task_reopens SET lease_id = NULL, lease_acquired_at = NULL, updated_at = now()
      WHERE job_id = $1 AND task_index = $2 AND generation = $3 AND lease_id = $4 RETURNING job_id
    ) UPDATE agent_jobs j SET tasks = jsonb_set(j.tasks, ARRAY[$2::text], (j.tasks -> $2::int) - 'reopenLeaseId', false)
      FROM released WHERE j.job_id = released.job_id RETURNING j.job_id`,
    [jobId, taskIndex, generation, leaseId]);
    return Boolean(row);
  }

  async recentSpawnJob(parentThreadId: string | undefined, parentAgentId: string | undefined, label: string, since: number): Promise<AgentJob | undefined> {
    const rows = await this.connection.select(`SELECT * FROM agent_jobs
      WHERE (($1::text IS NOT NULL AND parent_thread_id = $1) OR ($1::text IS NULL AND parent_thread_id IS NULL AND parent_agent_id = $2))
        AND created_at >= to_timestamp($3 / 1000.0)
        AND status <> 'stopped'
        AND jsonb_array_length(tasks) = 1
        AND tasks -> 0 ->> 'label' = $4
      ORDER BY created_at DESC LIMIT 1`, [parentThreadId ?? null, parentAgentId ?? null, since, label]);
    return rows[0] ? this.map(rows[0]) : undefined;
  }

  async jobsForParentThread(parentThreadId: string): Promise<AgentJob[]> {
    const rows = await this.connection.select(`SELECT * FROM agent_jobs WHERE parent_thread_id = $1 AND dismissed_at IS NULL ORDER BY created_at ASC`, [parentThreadId]);
    return rows.map(row => this.map(row));
  }

  async dismissTasks(jobId: string, parentThreadId: string, tasks: AgentJobTask[], allDismissed: boolean): Promise<void> {
    await this.connection.run(`UPDATE agent_jobs SET tasks = $3::jsonb, dismissed_at = CASE WHEN $4 THEN now() ELSE dismissed_at END WHERE job_id = $1 AND parent_thread_id = $2`, [jobId, parentThreadId, JSON.stringify(tasks), allDismissed]);
  }

  async stop(jobId: string, tasks: AgentJobTask[], stoppedBy: AgentJob['stoppedBy'], reason: string): Promise<void> {
    await this.connection.run(`UPDATE agent_jobs SET status = 'stopped', finished_at = now(), waiting_on_children = 0, completion_delivered_at = now(), tasks = $2::jsonb, stopped_by = $3::jsonb, stop_reason = $4 WHERE job_id = $1 AND status IN ('running', 'parked')`, [jobId, JSON.stringify(tasks), JSON.stringify(stoppedBy), reason]);
  }

  async stopCascade(jobId: string, stoppedBy: AgentJob['stoppedBy'], reason: string): Promise<string[]> {
    const rows = await this.connection.select(`WITH RECURSIVE descendants AS (
      SELECT job_id, tasks FROM agent_jobs WHERE job_id = $1
      UNION ALL
      SELECT child.job_id, child.tasks FROM agent_jobs child
      JOIN descendants parent ON child.parent_thread_id IN (SELECT value->>'threadId' FROM jsonb_array_elements(parent.tasks) value)
    )
    UPDATE agent_jobs target SET status = 'stopped', finished_at = now(), waiting_on_children = 0, completion_delivered_at = now(),
      stopped_by = $2::jsonb, stop_reason = $3, tasks = (SELECT COALESCE(jsonb_agg(CASE WHEN value->>'status' IN ('queued','running','parked') THEN value || jsonb_build_object('status','stopped','finishedAt',(extract(epoch from now())*1000)::bigint) ELSE value END), '[]'::jsonb) FROM jsonb_array_elements(target.tasks) value)
    FROM descendants WHERE target.job_id = descendants.job_id AND target.status IN ('running','parked') RETURNING target.job_id` , [jobId, JSON.stringify(stoppedBy), reason]);
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
      parent_agent_id, visibility, project_task_ids, completion_delivered_at, dismissed_at, waiting_on_children,
      orphaned_child_notices, stopped_by, stop_reason, '[]'::jsonb AS results,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('agentId', task->>'agentId', 'label', task->>'label',
      'taskId', task->>'taskId', 'status', task->>'status', 'visibility', task->>'visibility',
      'startedAt', task->'startedAt', 'finishedAt', task->'finishedAt', 'returnedAt', task->'returnedAt',
      'waitReason', task->>'waitReason', 'wakeAt', task->'wakeAt',
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
    const row = await this.connection.first(`SELECT count(*)::int AS count
      FROM agent_jobs child
      CROSS JOIN LATERAL jsonb_array_elements(child.tasks) AS task
      WHERE child.parent_thread_id = $1
        AND child.status IN ('running', 'parked')
        AND task->>'status' IN ('queued', 'running', 'parked')`, [threadId]);
    return Number(row?.count) || 0;
  }

  async saveStoppedResults(jobId: string, results: AgentJobResult[], tasks: AgentJobTask[]): Promise<void> {
    await this.connection.run(`UPDATE agent_jobs SET results = $2::jsonb, tasks = $3::jsonb WHERE job_id = $1`, [jobId, JSON.stringify(results), JSON.stringify(tasks)]);
  }

  async complete(job: AgentJob): Promise<void> {
    await this.connection.run(`UPDATE agent_jobs SET status = $2, finished_at = now(), waiting_on_children = 0, error = $3, results = $4::jsonb, tasks = $5::jsonb WHERE job_id = $1 AND status <> 'stopped'`, [job.jobId, job.status, job.error ?? null, JSON.stringify(job.results), JSON.stringify(job.tasks)]);
  }

  async markCompletionDelivered(jobId: string): Promise<void> {
    await this.connection.run(`UPDATE agent_jobs SET completion_delivered_at = now() WHERE job_id = $1 AND completion_delivered_at IS NULL`, [jobId]);
  }

  async pendingCompletions(): Promise<AgentJob[]> {
    const rows = await this.connection.select(`SELECT * FROM agent_jobs
      WHERE completion_delivered_at IS NULL
        AND status <> 'stopped'
        AND tasks @? '$[*] ? (@.completion != null && !exists(@.completionDeliveredAt))'
        AND parent_channel IS NOT NULL
        AND parent_thread_id IS NOT NULL
      ORDER BY COALESCE(finished_at, created_at) ASC`);
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

  async appendOrphanNotice(jobId: string, notice: OrphanedChildNotice): Promise<boolean> {
    const inserted = await this.connection.first(`UPDATE agent_jobs SET orphaned_child_notices = orphaned_child_notices || $2::jsonb
      WHERE job_id = $1 AND NOT orphaned_child_notices @> $3::jsonb
      RETURNING job_id`, [jobId, JSON.stringify([notice]), JSON.stringify([{ childJobId: notice.childJobId, taskIndex: notice.taskIndex }])]);
    return Boolean(inserted);
  }

  async deleteJob(jobId: string): Promise<void> { await this.query().where('job_id', jobId).delete(); }
}

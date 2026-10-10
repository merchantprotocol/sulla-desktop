/**
 * Registry for tracking async sub-agent jobs.
 *
 * Two layers, one owner (mirrors the SullaSettingsModel philosophy —
 * the model owns persistence, callers never touch the store directly):
 *   • In-memory Map — the hot cache; source of truth while the app runs.
 *   • Postgres agent_jobs table (migration 0043) — write-through copy so
 *     a restart no longer silently loses running jobs and their results.
 *
 * On first use after boot, stale 'running' rows are swept to 'failed'
 * ("app restarted mid-job") so check_agent_jobs answers honestly instead
 * of "not found". AbortControllers are in-memory ONLY — a signal cannot
 * survive a restart, and after the boot sweep a restarted job is
 * correctly reported dead, so nothing needs one.
 *
 * Jobs are cleaned up after retrieval or after a TTL (1 hour) — this is
 * operational state, not history; rows are really deleted.
 */

import { postgresClient } from '../../database/PostgresClient';
import { WorkTaskOwnershipModel } from '../../database/models/WorkTaskOwnershipModel';

export interface AgentJobResult {
  label:    string;
  status:   'completed' | 'blocked' | 'error';
  output:   string;
  threadId: string;
}

export interface AgentJobTask {
  agentId:    string;
  label:      string;
  prompt:     string;
  status:     'queued' | 'running' | 'completed' | 'blocked' | 'error' | 'stopped';
  threadId?:  string;
  startedAt?: number;
  finishedAt?: number;
  dismissed?:  boolean;
}

export interface AgentJob {
  jobId:      string;
  status:     'running' | 'completed' | 'failed' | 'stopped';
  createdAt:  number;
  finishedAt: number | null;
  taskCount:  number;
  results:    AgentJobResult[];
  tasks:      AgentJobTask[];
  error?:     string;
  parentChannel?: string;
  parentThreadId?: string;
  completionDeliveredAt?: number | null;
  dismissedAt?: number | null;
}

const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour
const jobs = new Map<string, AgentJob>();

// Per-job AbortController. Kept out of the AgentJob record so it never leaks
// into JSON responses. The controller's signal is threaded into each spawned
// sub-agent's `metadata.options.abort`, the same signal the graph honours for
// the user's stop button — so aborting it cooperatively unwinds the sub-agents.
const abortControllers = new Map<string, AbortController>();

let jobCounter = 0;

// ── Persistence (write-through; never blocks the happy path on failure) ──

async function dbWrite(sql: string, params: any[]): Promise<void> {
  try {
    await postgresClient.query(sql, params);
  } catch (err) {
    // The Map stays authoritative for this process lifetime — a failed
    // write only costs restart durability, never the running job.
    console.warn('[jobRegistry] persistence write failed (job continues in-memory):', (err as Error).message);
  }
}

function rowToJob(r: any): AgentJob {
  return {
    jobId:      r.job_id,
    status:     r.status,
    createdAt:  new Date(r.created_at).getTime(),
    finishedAt: r.finished_at ? new Date(r.finished_at).getTime() : null,
    taskCount:  Number(r.task_count) || 0,
    results:    Array.isArray(r.results) ? r.results : [],
    tasks:      Array.isArray(r.tasks) ? r.tasks : [],
    error:      r.error ?? undefined,
    parentChannel: r.parent_channel ?? undefined,
    parentThreadId: r.parent_thread_id ?? undefined,
    completionDeliveredAt: r.completion_delivered_at ? new Date(r.completion_delivered_at).getTime() : null,
    dismissedAt: r.dismissed_at ? new Date(r.dismissed_at).getTime() : null,
  };
}

// One-time sweep after boot: any row still 'running' belonged to a previous
// process — its promise chain is gone, so report it dead, honestly.
let bootSweepDone: Promise<void> | null = null;
function ensureBootSweep(): Promise<void> {
  bootSweepDone ??= (async() => {
    try {
      const swept = await postgresClient.query(
        `UPDATE agent_jobs
            SET status = 'failed', error = 'app restarted mid-job', finished_at = now()
          WHERE status = 'running'
          RETURNING job_id`,
      ) as any[];
      // Jobs that died with the previous process hand their tasks back.
      await WorkTaskOwnershipModel.releaseSweptJobs((swept ?? []).map((row: any) => row.job_id));
    } catch (err) {
      console.warn('[jobRegistry] boot sweep failed (will rely on in-memory state):', (err as Error).message);
    }
  })();

  return bootSweepDone;
}

// ── API ────────────────────────────────────────────────────────────────

export async function createJob(taskInput: number | AgentJobTask[], parentChannel?: string, parentThreadId?: string): Promise<AgentJob> {
  await ensureBootSweep();
  jobCounter += 1;
  const tasks = Array.isArray(taskInput) ? taskInput : [];
  const taskCount = Array.isArray(taskInput) ? taskInput.length : taskInput;
  const jobId = `agent-job-${ Date.now() }-${ jobCounter }`;
  const job: AgentJob = {
    jobId,
    status:     'running',
    createdAt:  Date.now(),
    finishedAt: null,
    taskCount,
    results:    [],
    tasks,
    parentChannel,
    parentThreadId,
    completionDeliveredAt: null,
    dismissedAt: null,
  };

  jobs.set(jobId, job);
  abortControllers.set(jobId, new AbortController());

  await dbWrite(
    `INSERT INTO agent_jobs (job_id, status, task_count, parent_channel, parent_thread_id, created_at, tasks)
     VALUES ($1, 'running', $2, $4, $5, to_timestamp($3 / 1000.0), $6::jsonb)
     ON CONFLICT (job_id) DO NOTHING`,
    [jobId, taskCount, job.createdAt, parentChannel ?? null, parentThreadId ?? null, JSON.stringify(tasks)],
  );

  return job;
}

/** Update one task in the hot cache and its durable display copy. */
export async function updateJobTask(jobId: string, index: number, patch: Partial<AgentJobTask>): Promise<void> {
  const job = jobs.get(jobId);
  if (!job?.tasks[index]) return;
  const nextPatch = job.status === 'stopped' && patch.status && patch.status !== 'stopped'
    ? { ...patch, status: 'stopped' as const }
    : patch;
  job.tasks[index] = { ...job.tasks[index], ...nextPatch };
  await dbWrite(`UPDATE agent_jobs SET tasks = $2::jsonb WHERE job_id = $1`, [jobId, JSON.stringify(job.tasks)]);
}

/** Visible jobs for one graph thread. Hot cache wins over persisted rows. */
export async function getJobsForParentThread(parentThreadId: string): Promise<AgentJob[]> {
  await ensureBootSweep();
  try {
    const rows = await postgresClient.query<any>(
      `SELECT * FROM agent_jobs
       WHERE parent_thread_id = $1 AND dismissed_at IS NULL
       ORDER BY created_at ASC`,
      [parentThreadId],
    );
    for (const row of rows ?? []) {
      if (!jobs.has(row.job_id)) jobs.set(row.job_id, rowToJob(row));
    }
  } catch (err) {
    console.warn('[jobRegistry] thread job read failed:', (err as Error).message);
  }

  return Array.from(jobs.values())
    .filter(job => job.parentThreadId === parentThreadId && !job.dismissedAt)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export async function dismissJobTask(jobId: string, parentThreadId: string, taskIndex: number): Promise<boolean> {
  const job = await getJob(jobId);
  if (job?.parentThreadId !== parentThreadId || !job.tasks[taskIndex]) return false;
  job.tasks[taskIndex] = { ...job.tasks[taskIndex], dismissed: true };
  const allDismissed = job.tasks.length > 0 && job.tasks.every(task => task.dismissed);
  if (allDismissed) job.dismissedAt = Date.now();
  await dbWrite(
    `UPDATE agent_jobs
       SET tasks = $3::jsonb,
           dismissed_at = CASE WHEN $4 THEN now() ELSE dismissed_at END
     WHERE job_id = $1 AND parent_thread_id = $2`,
    [jobId, parentThreadId, JSON.stringify(job.tasks), allDismissed],
  );
  return true;
}

/** The abort signal for a job, for wiring into its sub-agents' state. */
export function getJobAbortSignal(jobId: string): AbortSignal | undefined {
  return abortControllers.get(jobId)?.signal;
}

/**
 * Request cancellation of a running job. Fires its AbortController (which the
 * sub-agent graphs check cooperatively between steps) and marks it 'stopped'.
 * Cooperative, not preemptive: an in-flight LLM/tool call finishes first, then
 * the loop sees the aborted signal and unwinds. Returns the outcome so the tool
 * can report accurately.
 */
export function abortJob(jobId: string): 'stopped' | 'not-found' | 'already-finished' {
  const job = jobs.get(jobId);
  if (!job) return 'not-found';
  if (job.status !== 'running') return 'already-finished';

  abortControllers.get(jobId)?.abort();
  job.status = 'stopped';
  job.finishedAt = Date.now();
  job.tasks = job.tasks.map(task => task.status === 'running' || task.status === 'queued'
    ? { ...task, status: 'stopped', finishedAt: job.finishedAt ?? Date.now() }
    : task);

  void dbWrite(
    `UPDATE agent_jobs SET status = 'stopped', finished_at = now(), tasks = $2::jsonb WHERE job_id = $1`,
    [jobId, JSON.stringify(job.tasks)],
  ).then(() => releaseOwnedTasks(jobId));

  return 'stopped';
}

export async function getJob(jobId: string): Promise<AgentJob | undefined> {
  await ensureBootSweep();
  const cached = jobs.get(jobId);
  if (cached) return cached;

  // Cache miss — a pre-restart job may still exist in Postgres (swept to
  // 'failed' by ensureBootSweep, or finished before the restart).
  try {
    const rows = await postgresClient.query(
      `SELECT * FROM agent_jobs WHERE job_id = $1`, [jobId],
    ) as any[];
    if (rows?.[0]) {
      const job = rowToJob(rows[0]);
      jobs.set(jobId, job);

      return job;
    }
  } catch (err) {
    console.warn('[jobRegistry] persistence read failed:', (err as Error).message);
  }

  return undefined;
}

export async function getAllJobs(): Promise<AgentJob[]> {
  await ensureBootSweep();
  await pruneStaleJobs();

  // Union: in-memory (authoritative for this process) + persisted rows the
  // Map doesn't know about (pre-restart jobs within TTL).
  try {
    const rows = await postgresClient.query(`SELECT * FROM agent_jobs`) as any[];
    for (const r of rows ?? []) {
      if (!jobs.has(r.job_id)) jobs.set(r.job_id, rowToJob(r));
    }
  } catch (err) {
    console.warn('[jobRegistry] persistence read failed:', (err as Error).message);
  }

  return Array.from(jobs.values());
}

export async function completeJob(jobId: string, results: AgentJobResult[]): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;
  abortControllers.delete(jobId);

  // A stopped job may still settle its in-flight promise afterwards — keep the
  // 'stopped' verdict but record whatever partial results came back.
  if (job.status === 'stopped') {
    job.results = results;
    job.tasks = job.tasks.map(task => task.status === 'running' || task.status === 'queued'
      ? { ...task, status: 'stopped', finishedAt: Date.now() }
      : task);
    await dbWrite(`UPDATE agent_jobs SET results = $2::jsonb, tasks = $3::jsonb WHERE job_id = $1`, [jobId, JSON.stringify(results), JSON.stringify(job.tasks)]);

    return;
  }

  job.status = 'completed';
  job.finishedAt = Date.now();
  job.results = results;
  job.tasks = job.tasks.map((task, index) => {
    const result = results[index];
    if (!result) return task;
    return { ...task, status: result.status, threadId: result.threadId || task.threadId, finishedAt: Date.now() };
  });

  await dbWrite(
    `UPDATE agent_jobs SET status = 'completed', finished_at = now(), results = $2::jsonb, tasks = $3::jsonb, completion_delivered_at = NULL WHERE job_id = $1`,
    [jobId, JSON.stringify(results), JSON.stringify(job.tasks)],
  );
  await releaseOwnedTasks(jobId);
}

/** Mark a persisted completion delivered only after the graph wake was sent. */
export async function markCompletionDelivered(jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (job) job.completionDeliveredAt = Date.now();
  await dbWrite(
    `UPDATE agent_jobs SET completion_delivered_at = now() WHERE job_id = $1 AND status = 'completed' AND completion_delivered_at IS NULL`,
    [jobId],
  );
}

/** Read completed reports whose graph wake was not durably acknowledged. */
export async function getPendingCompletions(): Promise<AgentJob[]> {
  await ensureBootSweep();
  try {
    const rows = await postgresClient.query(
      `SELECT * FROM agent_jobs
         WHERE status = 'completed' AND completion_delivered_at IS NULL
           AND parent_channel IS NOT NULL AND parent_thread_id IS NOT NULL
         ORDER BY finished_at ASC`,
    ) as any[];
    return (rows ?? []).map(rowToJob);
  } catch (err) {
    console.warn('[jobRegistry] pending completion read failed:', (err as Error).message);
    return [];
  }
}

export function failJob(jobId: string, error: string): void {
  const job = jobs.get(jobId);
  if (!job) return;
  abortControllers.delete(jobId);

  // Don't clobber an explicit stop with the abort-induced rejection.
  if (job.status === 'stopped') return;

  job.status = 'failed';
  job.finishedAt = Date.now();
  job.error = error;
  job.tasks = job.tasks.map(task => task.status === 'running' || task.status === 'queued'
    ? { ...task, status: 'error', finishedAt: Date.now() }
    : task);

  void dbWrite(
    `UPDATE agent_jobs SET status = 'failed', finished_at = now(), error = $2, tasks = $3::jsonb WHERE job_id = $1`,
    [jobId, error, JSON.stringify(job.tasks)],
  ).then(() => releaseOwnedTasks(jobId));
}

/** Hand a finished job's Projects tasks back; never fails the caller. */
async function releaseOwnedTasks(jobId: string): Promise<void> {
  try {
    await WorkTaskOwnershipModel.releaseForJob(jobId);
  } catch (err) {
    console.warn(`[jobRegistry] could not release tasks owned by ${ jobId }:`, (err as Error).message);
  }
}

export function deleteJob(jobId: string): void {
  jobs.delete(jobId);
  abortControllers.delete(jobId);
  void dbWrite(`DELETE FROM agent_jobs WHERE job_id = $1`, [jobId]);
}

async function pruneStaleJobs(): Promise<void> {
  const now = Date.now();

  for (const [id, job] of jobs.entries()) {
    if (job.dismissedAt && (now - job.dismissedAt) > JOB_TTL_MS) {
      jobs.delete(id);
      abortControllers.delete(id);
    }
  }

  await dbWrite(
    `DELETE FROM agent_jobs WHERE dismissed_at IS NOT NULL AND dismissed_at < now() - interval '1 hour'`,
    [],
  );
}

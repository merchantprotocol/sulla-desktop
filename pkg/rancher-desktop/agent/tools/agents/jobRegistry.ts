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

export interface AgentJobResult {
  label:    string;
  status:   'completed' | 'blocked' | 'error';
  output:   string;
  threadId: string;
}

export interface AgentJob {
  jobId:      string;
  status:     'running' | 'completed' | 'failed' | 'stopped';
  createdAt:  number;
  finishedAt: number | null;
  taskCount:  number;
  results:    AgentJobResult[];
  error?:     string;
  parentChannel?: string;
  parentThreadId?: string;
  completionDeliveredAt?: number | null;
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
    error:      r.error ?? undefined,
    parentChannel: r.parent_channel ?? undefined,
    parentThreadId: r.parent_thread_id ?? undefined,
    completionDeliveredAt: r.completion_delivered_at ? new Date(r.completion_delivered_at).getTime() : null,
  };
}

// One-time sweep after boot: any row still 'running' belonged to a previous
// process — its promise chain is gone, so report it dead, honestly.
let bootSweepDone: Promise<void> | null = null;
function ensureBootSweep(): Promise<void> {
  bootSweepDone ??= (async() => {
    try {
      await postgresClient.query(
        `UPDATE agent_jobs
            SET status = 'failed', error = 'app restarted mid-job', finished_at = now()
          WHERE status = 'running'`,
      );
    } catch (err) {
      console.warn('[jobRegistry] boot sweep failed (will rely on in-memory state):', (err as Error).message);
    }
  })();

  return bootSweepDone;
}

// ── API ────────────────────────────────────────────────────────────────

export async function createJob(taskCount: number, parentChannel?: string, parentThreadId?: string): Promise<AgentJob> {
  await ensureBootSweep();
  jobCounter += 1;
  const jobId = `agent-job-${ Date.now() }-${ jobCounter }`;
  const job: AgentJob = {
    jobId,
    status:     'running',
    createdAt:  Date.now(),
    finishedAt: null,
    taskCount,
    results:    [],
    parentChannel,
    parentThreadId,
    completionDeliveredAt: null,
  };

  jobs.set(jobId, job);
  abortControllers.set(jobId, new AbortController());

  await dbWrite(
    `INSERT INTO agent_jobs (job_id, status, task_count, parent_channel, parent_thread_id, created_at)
     VALUES ($1, 'running', $2, $4, $5, to_timestamp($3 / 1000.0))
     ON CONFLICT (job_id) DO NOTHING`,
    [jobId, taskCount, job.createdAt, parentChannel ?? null, parentThreadId ?? null],
  );

  return job;
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

  void dbWrite(
    `UPDATE agent_jobs SET status = 'stopped', finished_at = now() WHERE job_id = $1`,
    [jobId],
  );

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
    await dbWrite(`UPDATE agent_jobs SET results = $2::jsonb WHERE job_id = $1`, [jobId, JSON.stringify(results)]);

    return;
  }

  job.status = 'completed';
  job.finishedAt = Date.now();
  job.results = results;

  await dbWrite(
    `UPDATE agent_jobs SET status = 'completed', finished_at = now(), results = $2::jsonb, completion_delivered_at = NULL WHERE job_id = $1`,
    [jobId, JSON.stringify(results)],
  );
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

  void dbWrite(
    `UPDATE agent_jobs SET status = 'failed', finished_at = now(), error = $2 WHERE job_id = $1`,
    [jobId, error],
  );
}

export function deleteJob(jobId: string): void {
  jobs.delete(jobId);
  abortControllers.delete(jobId);
  void dbWrite(`DELETE FROM agent_jobs WHERE job_id = $1`, [jobId]);
}

async function pruneStaleJobs(): Promise<void> {
  const now = Date.now();

  for (const [id, job] of jobs.entries()) {
    if (job.finishedAt && (now - job.finishedAt) > JOB_TTL_MS) {
      jobs.delete(id);
      abortControllers.delete(id);
    }
  }

  await dbWrite(
    `DELETE FROM agent_jobs WHERE finished_at IS NOT NULL AND finished_at < now() - interval '1 hour'`,
    [],
  );
}

/**
 * In-memory registry for tracking async sub-agent jobs.
 * Jobs are cleaned up after retrieval or after a TTL (1 hour).
 */

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
}

const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour
const jobs = new Map<string, AgentJob>();

// Per-job AbortController. Kept out of the AgentJob record so it never leaks
// into JSON responses. The controller's signal is threaded into each spawned
// sub-agent's `metadata.options.abort`, the same signal the graph honours for
// the user's stop button — so aborting it cooperatively unwinds the sub-agents.
const abortControllers = new Map<string, AbortController>();

let jobCounter = 0;

export function createJob(taskCount: number): AgentJob {
  jobCounter += 1;
  const jobId = `agent-job-${ Date.now() }-${ jobCounter }`;
  const job: AgentJob = {
    jobId,
    status:     'running',
    createdAt:  Date.now(),
    finishedAt: null,
    taskCount,
    results:    [],
  };

  jobs.set(jobId, job);
  abortControllers.set(jobId, new AbortController());

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

  return 'stopped';
}

export function getJob(jobId: string): AgentJob | undefined {
  return jobs.get(jobId);
}

export function getAllJobs(): AgentJob[] {
  pruneStaleJobs();

  return Array.from(jobs.values());
}

export function completeJob(jobId: string, results: AgentJobResult[]): void {
  const job = jobs.get(jobId);
  if (!job) return;
  abortControllers.delete(jobId);

  // A stopped job may still settle its in-flight promise afterwards — keep the
  // 'stopped' verdict but record whatever partial results came back.
  if (job.status === 'stopped') {
    job.results = results;

    return;
  }

  job.status = 'completed';
  job.finishedAt = Date.now();
  job.results = results;
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
}

export function deleteJob(jobId: string): void {
  jobs.delete(jobId);
  abortControllers.delete(jobId);
}

function pruneStaleJobs(): void {
  const now = Date.now();

  for (const [id, job] of jobs.entries()) {
    if (job.finishedAt && (now - job.finishedAt) > JOB_TTL_MS) {
      jobs.delete(id);
      abortControllers.delete(id);
    }
  }
}

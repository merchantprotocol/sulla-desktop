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
  status:     'running' | 'completed' | 'failed';
  createdAt:  number;
  finishedAt: number | null;
  taskCount:  number;
  results:    AgentJobResult[];
  error?:     string;
}

const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour
const jobs = new Map<string, AgentJob>();

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

  return job;
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

  job.status = 'completed';
  job.finishedAt = Date.now();
  job.results = results;
}

export function failJob(jobId: string, error: string): void {
  const job = jobs.get(jobId);
  if (!job) return;

  job.status = 'failed';
  job.finishedAt = Date.now();
  job.error = error;
}

export function deleteJob(jobId: string): void {
  jobs.delete(jobId);
}

function pruneStaleJobs(): void {
  const now = Date.now();

  for (const [id, job] of jobs.entries()) {
    if (job.finishedAt && (now - job.finishedAt) > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
}

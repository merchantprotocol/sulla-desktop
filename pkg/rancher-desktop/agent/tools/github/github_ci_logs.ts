import { Octokit } from '@octokit/rest';

import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';

type CheckLike = {
  id: number;
  name: string;
  status?: string | null;
  conclusion?: string | null;
  html_url?: string | null;
  details_url?: string | null;
  check_run_url?: string | null;
};

const FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);

export function trimJobLog(log: string, maxLines: number): string {
  const lines = log.replace(/\r/g, '').split('\n');
  if (lines.length <= maxLines) return lines.join('\n').trim();
  let failure = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (/##\[error\]|Process completed with exit code|Error:|FAILED|failure/i.test(lines[index])) {
      failure = index;
      break;
    }
  }
  if (failure < 0) return lines.slice(-maxLines).join('\n').trim();
  let start = Math.max(0, failure - maxLines + 1);
  for (let index = failure; index >= start; index--) {
    if (/##\[group\]|##\[section\].*Run|Starting:/.test(lines[index])) {
      start = index;
      break;
    }
  }
  return lines.slice(start, Math.min(lines.length, start + maxLines)).join('\n').trim();
}

function jobIdFromCheck(check: CheckLike): number | null {
  const match = check.details_url?.match(/\/job\/(\d+)/);
  return match ? Number(match[1]) : null;
}

function checkRunId(job: CheckLike): number {
  const match = job.check_run_url?.match(/\/check-runs\/(\d+)/);
  return match ? Number(match[1]) : job.id;
}

function responseText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  return data == null ? '' : String(data);
}

export class GitHubCILogsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const owner = typeof input.owner === 'string' ? input.owner.trim() : '';
    const repo = typeof input.repo === 'string' ? input.repo.trim() : '';
    const runId = Number.isInteger(input.runId) && input.runId > 0 ? input.runId : undefined;
    const jobId = Number.isInteger(input.jobId) && input.jobId > 0 ? input.jobId : undefined;
    const ref = typeof input.ref === 'string' && input.ref.trim() ? input.ref.trim() : undefined;
    const failedOnly = input.failedOnly !== false;
    const maxLines = Math.min(2_000, Math.max(20, Number.isInteger(input.maxLines) ? input.maxLines : 300));
    if (!owner || !repo || [runId, jobId, ref].filter(Boolean).length !== 1) {
      return { successBoolean: false, responseString: 'owner and repo are required; provide exactly one of runId, jobId, or ref.' };
    }

    const tokenValue = await getIntegrationService().getIntegrationValue('github', 'token');
    if (!tokenValue) return { successBoolean: false, responseString: 'GitHub token not configured in vault.' };
    const octokit = new Octokit({ auth: tokenValue.value });

    try {
      let jobs: CheckLike[] = [];
      if (jobId) {
        const response = await octokit.actions.getJobForWorkflowRun({ owner, repo, job_id: jobId });
        jobs = [response.data as CheckLike];
      } else if (runId) {
        const response = await octokit.actions.listJobsForWorkflowRun({ owner, repo, run_id: runId, per_page: 100 });
        jobs = response.data.jobs as CheckLike[];
      } else {
        const response = await octokit.checks.listForRef({ owner, repo, ref: ref!, per_page: 100 });
        jobs = response.data.check_runs as CheckLike[];
      }

      const selected = failedOnly ? jobs.filter(job => FAILURE_CONCLUSIONS.has(job.conclusion ?? '')) : jobs;
      const header = `${ jobs.length } CI job/check run(s) found; ${ selected.length } selected${ failedOnly ? ' failing' : ''}.`;
      const runList = jobs.length
        ? `\nRuns:\n${ jobs.map(job => `  [${ job.conclusion || job.status || 'unknown' }] ${ job.name }${ job.html_url ? ` — ${ job.html_url }` : '' }`).join('\n') }`
        : '';
      if (!selected.length) return { successBoolean: true, responseString: header + runList };

      const sections: string[] = [header + runList];
      for (const job of selected) {
        const resolvedJobId = jobId ?? jobIdFromCheck(job) ?? job.id;
        let annotations = 'No annotations.';
        try {
          const response = await octokit.checks.listAnnotations({ owner, repo, check_run_id: checkRunId(job), per_page: 100 });
          if (response.data.length) {
            annotations = response.data.map(annotation => {
              const location = annotation.path
                ? `${ annotation.path }${ annotation.start_line ? `:${ annotation.start_line }` : '' }`
                : '(no file)';
              return `  ${ String(annotation.annotation_level || 'notice').toUpperCase() } ${ location } — ${ annotation.title ? `${ annotation.title }: ` : '' }${ annotation.message }`;
            }).join('\n');
          }
        } catch (error: any) {
          annotations = `Annotations unavailable: ${ error?.response?.data?.message || error?.message || String(error) }`;
        }

        let log = '';
        try {
          const response = await octokit.request('GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs', {
            owner, repo, job_id: resolvedJobId,
          });
          log = trimJobLog(responseText(response.data), maxLines);
        } catch (error: any) {
          log = `Job log unavailable: ${ error?.response?.data?.message || error?.message || String(error) }`;
        }

        sections.push(
          `\n[${ job.conclusion || job.status || 'unknown' }] ${ job.name } (job ${ resolvedJobId })${ job.html_url ? ` — ${ job.html_url }` : '' }` +
          `\nAnnotations:\n${ annotations }\nLog (up to ${ maxLines } lines around the failure):\n${ log || 'No log content returned.' }`,
        );
      }
      return { successBoolean: true, responseString: sections.join('\n') };
    } catch (error: any) {
      const message = error?.response?.data?.message || error?.message || String(error);
      return { successBoolean: false, responseString: `CI logs failed: ${ message }` };
    }
  }
}

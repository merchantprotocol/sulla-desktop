// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BaseTool, ToolResponse } from '../base';
import { agentJobProvider } from '../../app/Providers/AgentJobServiceProvider';
import type { AgentFleetProjectionService } from '../../app/Services/AgentFleetProjectionService';
import { AgentFleetTreeFormatter } from '../../app/Formatters/AgentFleetTreeFormatter';
import { PullRequestReferenceExtractor } from '../../app/Formatters/PullRequestReferenceExtractor';
import { JobCustodyFormatter } from '../../app/Services/JobCustodyFormatter';
import type { AgentJob } from './jobRegistry';

export class CheckAgentJobsWorker extends BaseTool {
  name = '';
  description = '';

  constructor(
    private readonly fleet: AgentFleetProjectionService = agentJobProvider.fleet,
    private readonly tree = new AgentFleetTreeFormatter(new PullRequestReferenceExtractor()),
    private readonly custody = new JobCustodyFormatter(agentJobProvider.custody),
    private readonly jobs: { job(jobId: string): Promise<AgentJob | undefined> } = agentJobProvider.states,
  ) { super(); }

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const jobId = String(input.jobId ?? '').trim();
    if (jobId) {
      // Explicit history lookup remains global for backwards compatibility.
      const job = await this.fleet.job(jobId);
      if (!job) {
        return {
          successBoolean: false,
          responseString: `Job "${ jobId }" not found. It may not exist or may have been explicitly pruned after the retention period.`,
        };
      }
      const results = Array.isArray(job.results) ? job.results as Array<{ status?: string }> : [];
      // By-id lookups show who owns the job now and how custody moved (reassign/adopt/replace_lead).
      const record = await this.jobs.job(jobId);
      const custody = record ? await this.custody.format(record) : undefined;
      return {
        successBoolean: ['running', 'parked'].includes(String(job.status)) || (job.status === 'completed' && results.every(result => result.status === 'completed')),
        responseString: JSON.stringify(custody ? { ...job, custody } : job, null, 2),
      };
    }

    const scope = input.scope === 'all' ? 'all' : 'mine';
    const callerThreadId = String((this.state as any)?.metadata?.threadId ?? '').trim() || undefined;
    const jobs = await this.fleet.list({
      scope,
      callerThreadId,
      limit: Math.min(100, Math.max(1, Math.trunc(Number(input.limit)) || 25)),
      includeFinished: input.includeFinished !== false,
    });
    if (jobs.length === 0) return { successBoolean: true, responseString: 'No active or recent async agent jobs.' };
    if (input.view === 'tree') return { successBoolean: true, responseString: JSON.stringify(this.tree.format(jobs), null, 2) };
    return { successBoolean: true, responseString: JSON.stringify({ count: jobs.length, jobs }, null, 2) };
  }
}

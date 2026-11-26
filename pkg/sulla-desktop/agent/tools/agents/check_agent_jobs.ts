// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BaseTool, ToolResponse } from '../base';
import { agentJobProvider } from '../../app/Providers/AgentJobServiceProvider';
import type { AgentFleetProjectionService } from '../../app/Services/AgentFleetProjectionService';
import { AgentFleetTreeFormatter } from '../../app/Formatters/AgentFleetTreeFormatter';
import { PullRequestReferenceExtractor } from '../../app/Formatters/PullRequestReferenceExtractor';

export class CheckAgentJobsWorker extends BaseTool {
  name = '';
  description = '';

  constructor(
    private readonly fleet: AgentFleetProjectionService = agentJobProvider.fleet,
    private readonly tree = new AgentFleetTreeFormatter(new PullRequestReferenceExtractor()),
  ) { super(); }

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const jobId = String(input.jobId ?? '').trim();
    const callerThreadId = String((this.state as any)?.metadata?.threadId ?? '').trim() || undefined;
    if (input.view === 'implementation_source') {
      const { productOwnerWorkflow } = await import('../../services/ProductOwnerWorkflow');
      const source = !jobId && callerThreadId && await productOwnerWorkflow.readAssignedImplementationSource(callerThreadId);
      return source
        ? { successBoolean: true, responseString: JSON.stringify(source) }
        : { successBoolean: false, responseString: 'No saved implementation is assigned to this review or acceptance task.' };
    }
    if (jobId) {
      // Explicit history lookup remains global for backwards compatibility.
      const job = await this.fleet.job(jobId);
      if (!job) {
        return {
          successBoolean: false,
          responseString: `Job "${ jobId }" not found. It may not exist or may have been explicitly pruned after the retention period.`,
        };
      }
      // The read succeeded: a failed/stopped job status is data in the payload, not a tool failure.
      return { successBoolean: true, responseString: JSON.stringify(job, null, 2) };
    }

    const scope = input.scope === 'all' ? 'all' : 'mine';
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

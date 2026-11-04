// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { Service } from '@sulla/foundation';
import type { PendingCompletion } from './AgentCompletionInboxService';

export class CompletionFormatter extends Service {
  constructor(private readonly resultLimit: number) {
    super();
  }

  format(entries: PendingCompletion[]): string {
    return entries.map(entry => {
      const content = this.buildWakeContent(entry);
      if (content.length <= this.resultLimit) return content;
      return `${ content.slice(0, this.resultLimit) }\n\n[Result truncated. Use agents/check_agent_jobs for the full text of ${ entry.jobId }.]`;
    }).join('\n\n==========\n\n');
  }

  private buildWakeContent(entry: PendingCompletion): string {
    if (entry.failureReason) {
      return `[sub-agent job ${ entry.jobId } FAILED] ${ entry.failureReason }\n\n` +
        'Your background sub-agent(s) errored before returning results. Decide how to proceed (retry, adjust, or report back).';
    }
    const formatted = entry.results.map(result => {
      const contract = result.contract && result.contract !== 'result' ? ` · contract ${ result.contract }` : '';
      return `### ${ result.label } [${ result.status.toUpperCase() }]${ contract }\n${ result.output }`;
    }).join('\n\n---\n\n');
    return `[sub-agent job ${ entry.jobId } complete — ${ entry.results.length } result(s)]\n\n` +
      'These are the results returned by the sub-agent(s) you launched. ' +
      'Continue your orchestration using them (do NOT call check_agent_jobs for this job — the results are below):\n\n' +
      formatted;
  }
}

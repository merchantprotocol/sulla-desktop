// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { Service } from '@sulla/foundation';
import { buildWakeContent } from '../../tools/agents/jobDelivery';
import type { PendingCompletion } from './AgentCompletionInboxService';

export class CompletionFormatter extends Service {
  constructor(private readonly resultLimit: number) {
    super();
  }

  format(entries: PendingCompletion[]): string {
    return entries.map(entry => {
      const content = buildWakeContent(entry.jobId, entry.results, entry.failureReason);
      if (content.length <= this.resultLimit) return content;
      return `${ content.slice(0, this.resultLimit) }\n\n[Result truncated. Use agents/check_agent_jobs for the full text of ${ entry.jobId }.]`;
    }).join('\n\n==========\n\n');
  }
}

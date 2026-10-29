// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { enqueueAgentCompletion } from './AgentCompletionInbox';
import { getPendingCompletions } from '../tools/agents/jobRegistry';

let recoveryPromise: Promise<void> | null = null;
const inFlight = new Set<string>();

/**
 * Re-deliver completed delegation results (hidden or tab) after process
 * recovery, in the same wake format as the live delivery path.
 * Delivery is idempotent at the job level and remains pending if the message
 * bus is unavailable, so a later boot can retry it.
 */
export async function recoverPendingAgentCompletions(): Promise<void> {
  if (recoveryPromise) return recoveryPromise;
  recoveryPromise = (async() => {
    const jobs = await getPendingCompletions();
    for (const job of jobs) {
      if (inFlight.has(job.jobId) || !job.parentChannel || !job.parentThreadId) continue;
      inFlight.add(job.jobId);
      try {
        enqueueAgentCompletion(job.parentChannel, job.parentThreadId, {
          jobId: job.jobId, results: job.results,
        });
      } catch (error) {
        console.warn(`[AgentCompletionRecovery] delivery failed for ${ job.jobId }; will retry:`, error);
      } finally {
        inFlight.delete(job.jobId);
      }
    }
  })().finally(() => {
    recoveryPromise = null;
  });
  return recoveryPromise;
}

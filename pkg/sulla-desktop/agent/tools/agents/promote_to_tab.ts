// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BaseTool, ToolResponse } from '../base';
import { AgentTabPromoter, type PromotableJobStore } from '../../services/AgentTabPromoter';
import { openHiddenTaskTab } from '../../services/AgentTabOpener';
import { authorizeJobStop, getJob, markTaskPromoted } from './jobRegistry';
import { resolveAgentIdentity } from '../../utils/agentIdentity';
import { StopPrincipal } from '../../app/ValueObjects/StopPrincipal';

/** Job-registry adapter for the promoter. Only the calls it needs. */
const jobRegistryStore: PromotableJobStore = {
  getJob:           jobId => getJob(jobId),
  authorize:        async(jobId, principal) => (await authorizeJobStop(jobId, principal)).outcome,
  markTaskPromoted: (jobId, taskIndex) => markTaskPromoted(jobId, taskIndex),
};

/**
 * `agents/promote_to_tab {jobId, taskIndex?}`: show a running hidden task in a
 * visible tab bound to its existing thread. Only the job's ancestors or the
 * human can call it; the caller is verified from its own metadata.
 */
export class PromoteToTabWorker extends BaseTool {
  name = '';
  description = '';

  constructor(private readonly promoter = new AgentTabPromoter(jobRegistryStore, openHiddenTaskTab)) {
    super();
  }

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const jobId = typeof input.jobId === 'string' ? input.jobId.trim() : '';
    if (!jobId) return { successBoolean: false, responseString: 'jobId is required (the job that owns the task).' };

    const metadata = this.state?.metadata;
    const principal = StopPrincipal.agent(resolveAgentIdentity(metadata) || metadata?.routedAgentId, metadata?.threadId);
    if (!principal) return { successBoolean: false, responseString: 'Cannot promote: cannot verify caller.' };

    const taskIndex = input.taskIndex === undefined ? undefined : Number(input.taskIndex);
    const result = await this.promoter.promote(jobId, taskIndex, principal);
    if (!result.successBoolean) return { successBoolean: false, responseString: result.error ?? 'Promotion failed.' };

    const payload = { jobId, taskIndex: taskIndex ?? 0, visibility: 'tab', promotedToTab: true, tabId: result.tabId, alreadyVisible: result.alreadyVisible === true };
    return { successBoolean: true, responseString: JSON.stringify(payload, null, 2), result: payload };
  }
}

// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BaseTool, ToolResponse } from '../base';
import { SpawnAgentWorker } from '../agents/spawn_agent';

/**
 * Legacy alias of spawn_agent. Agents never open visible tabs (Jonathon,
 * 2026-11-02), so this launches a hidden async child with the same contract;
 * it shows in the parent's sub-agent rail and the human can open it there.
 */
export class LaunchAgentTabWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const brief = String(input.brief ?? input.prompt ?? '').trim();
    if (!brief) return { successBoolean: false, responseString: 'Agent-tab brief is required and cannot be empty.' };

    const result = await new SpawnAgentWorker().runValidated({
      tasks: [{
        agentId:       String(input.agentId ?? '').trim(),
        prompt:        brief,
        label:         typeof input.title === 'string' ? input.title : undefined,
        contract:      input.contract,
        projectTaskId: input.projectTaskId,
        visibility:    'hidden',
      }],
      async: true,
    }, this.state);
    if (!result.successBoolean) return result;

    const launched = JSON.parse(result.responseString);
    return {
      successBoolean: true,
      responseString: JSON.stringify({
        contractId: launched.contractId ?? launched.jobId,
        jobId:      launched.jobId,
        visibility: 'hidden',
      }),
    };
  }
}

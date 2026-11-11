// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentJobMessagingModel } from '../../database/models/AgentJobMessagingModel';
import { agentJobProvider } from '../../app/Providers/AgentJobServiceProvider';
import { BaseTool, ToolResponse } from '../base';
import { ReviewItemClosureValidator } from '../../app/Services/ReviewItemClosureValidator';

export class ReportProgressWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    // Hidden workers and tab children alike: the thread's job task is the
    // binding, not the isSubAgent flag (a tab child runs as a normal chat).
    const threadId = (this.state as any)?.metadata?.threadId;
    if (typeof threadId !== 'string' || !threadId) {
      return {
        successBoolean: false,
        responseString: 'report_progress is only available inside a delegated agent task (hidden or tab).',
      };
    }
    const step = String(input.step ?? 'progress').trim();
    const summary = String(input.summary ?? '').trim();
    if (!summary) {
      return { successBoolean: false, responseString: 'a non-empty summary is required.' };
    }
    const percent = input.percent === undefined ? undefined : Number(input.percent);
    if (percent !== undefined && (!Number.isFinite(percent) || percent < 0 || percent > 100)) {
      return { successBoolean: false, responseString: 'percent must be between 0 and 100.' };
    }

    const target = await AgentJobMessagingModel.taskForThread(threadId);
    if (target && Array.isArray(input.reviewUpdates) && input.reviewUpdates.length) {
      const open = await agentJobProvider.reviewItems.itemsForTask(target.jobId, target.taskIndex, true);
      const updates = input.reviewUpdates;
      const error = new ReviewItemClosureValidator().validate(updates, open.map(item => item.id));
      if (error) return { successBoolean: false, responseString: error };
      for (const update of updates) {
        if (update.status === 'acknowledged') await agentJobProvider.reviewItems.acknowledge(target.jobId, target.taskIndex, update.id);
        else await agentJobProvider.reviewItems.close(target.jobId, target.taskIndex, update.id, update.status, update.commit, update.reason, 'worker');
      }
    }
    const result = await agentJobProvider.blockerEscalation.record(threadId, {
      step,
      summary,
      filesTouched: Array.isArray(input.filesTouched) ? input.filesTouched.map(String) : [],
      blockers: Array.isArray(input.blockers) ? input.blockers.map(String) : [],
      percent,
    });
    if (!result) {
      return { successBoolean: false, responseString: 'No running delegated job task is bound to this thread.' };
    }

    agentJobProvider.states.touch();

    return {
      successBoolean: true,
      responseString: JSON.stringify({
        recorded: true,
        jobId: result.target.jobId,
        taskIndex: result.target.taskIndex,
        checkin: result.checkin,
      }, null, 2),
    };
  }
}

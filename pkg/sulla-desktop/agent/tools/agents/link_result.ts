// SPDX-License-Identifier: GPL-2.0-or-later
import { BaseTool, type ToolResponse } from '../base';
import { updateJobTask } from './jobRegistry';
import { agentJobProvider } from '../../app/Providers/AgentJobServiceProvider';
import { postgresClient } from '../../database/PostgresClient';
import { PendingDecisionRepository } from '../../repositories/PendingDecisionRepository';
import { ResultTrackingService } from '../../services/ResultTrackingService';

export function resultTrackingService() {
  return new ResultTrackingService({ job: id => agentJobProvider.jobs.job(id), update: updateJobTask, decision: id => new PendingDecisionRepository(postgresClient).findById(id) });
}

export class LinkResultWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      await resultTrackingService().link({ jobId: input.jobId, taskIndex: input.taskIndex }, input, String(this.state?.metadata?.threadId ?? ''));
      return { successBoolean: true, responseString: 'Result links recorded. No task or question status was changed.' };
    } catch (error) {
      return { successBoolean: false, responseString: (error as Error).message };
    }
  }
}

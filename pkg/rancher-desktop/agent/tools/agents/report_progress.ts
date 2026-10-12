import { AgentJobMessagingModel } from '../../database/models/AgentJobMessagingModel';
import { BaseTool, ToolResponse } from '../base';

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
    const step = String(input.step ?? '').trim();
    const summary = String(input.summary ?? '').trim();
    if (!step || !summary) {
      return { successBoolean: false, responseString: 'step and a non-empty summary are required.' };
    }
    const percent = input.percent === undefined ? undefined : Number(input.percent);
    if (percent !== undefined && (!Number.isFinite(percent) || percent < 0 || percent > 100)) {
      return { successBoolean: false, responseString: 'percent must be between 0 and 100.' };
    }

    const result = await AgentJobMessagingModel.appendCheckin(threadId, {
      step,
      summary,
      filesTouched: Array.isArray(input.filesTouched) ? input.filesTouched.map(String) : [],
      blockers: Array.isArray(input.blockers) ? input.blockers.map(String) : [],
      percent,
    });
    if (!result) {
      return { successBoolean: false, responseString: 'No running delegated job task is bound to this thread.' };
    }

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

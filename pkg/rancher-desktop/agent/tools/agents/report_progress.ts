import { AgentJobMessagingModel } from '../../database/models/AgentJobMessagingModel';
import { BaseTool, ToolResponse } from '../base';

export class ReportProgressWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const threadId = (this.state as any)?.metadata?.threadId;
    const metadata = (this.state as any)?.metadata;
    const jobId = typeof metadata?.spawnAgentJobId === 'string' ? metadata.spawnAgentJobId : '';
    const taskIndex = metadata?.spawnAgentTaskIndex;
    if (!metadata?.isSubAgent || typeof threadId !== 'string' || !threadId || !jobId || !Number.isInteger(taskIndex) || taskIndex < 0) {
      return {
        successBoolean: false,
        responseString: 'report_progress is only available inside a running spawn_agent worker task.',
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

    const result = await AgentJobMessagingModel.appendCheckinForTask(jobId, taskIndex, threadId, {
      step,
      summary,
      filesTouched: Array.isArray(input.filesTouched) ? input.filesTouched.map(String) : [],
      blockers: Array.isArray(input.blockers) ? input.blockers.map(String) : [],
      percent,
    });
    if (!result) {
      return { successBoolean: false, responseString: 'No running spawn_agent job task is bound to this worker thread.' };
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

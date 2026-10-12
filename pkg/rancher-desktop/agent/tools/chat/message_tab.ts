import { BaseTool, ToolResponse } from '../base';
import { findTaskByThread, getJob } from '../agents/jobRegistry';
import { sendJobMessage } from '../agents/send_job_message';

/**
 * Alias of send_job_message addressed by contract id (= job id) or child
 * thread id. Only the parent chat that launched the child may message it.
 */
export class MessageAgentTabWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const parentThreadId = String(this.state?.metadata?.threadId ?? '').trim();
    if (!parentThreadId) return { successBoolean: false, responseString: 'message_tab must be called from a parent chat thread.' };
    const contractId = typeof input.contractId === 'string' ? input.contractId.trim() : '';
    const childThreadId = typeof input.childThreadId === 'string' ? input.childThreadId.trim() : '';
    if (!contractId && !childThreadId) return { successBoolean: false, responseString: 'Provide contractId or childThreadId.' };

    const owner = contractId
      ? await getJob(contractId.split('#')[0]).then(job => job && { job, taskIndex: Number(contractId.split('#')[1] ?? 0) || 0 })
      : await findTaskByThread(childThreadId);
    if (!owner || owner.job.parentThreadId !== parentThreadId) {
      return { successBoolean: false, responseString: 'No matching child owned by this parent chat was found.' };
    }
    return sendJobMessage({ jobId: owner.job.jobId, taskIndex: owner.taskIndex, message: String(input.message ?? '').trim() });
  }
}

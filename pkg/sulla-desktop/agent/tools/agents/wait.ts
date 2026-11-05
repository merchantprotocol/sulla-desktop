// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { agentTaskParkingService } from '../../services/AgentWaitServices';
import { AgentWaitRequest } from '../../services/AgentWaitRequest';
import { BaseTool, ToolResponse } from '../base';
import { getJob, updateJobTask } from './jobRegistry';

export class AgentWaitWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const threadId = String((this.state as any)?.metadata?.threadId ?? '');
      const jobId = String((this.state as any)?.metadata?.delegatedJobId ?? '');
      if (!threadId || !jobId) return { successBoolean: false, responseString: 'agents/wait is only available inside a delegated task.' };
      const job = await getJob(jobId);
      const taskIndex = job?.tasks.findIndex(task => task.threadId === threadId) ?? -1;
      if (!job || taskIndex < 0 || !['running', 'parked'].includes(job.tasks[taskIndex].status)) {
        return { successBoolean: false, responseString: 'The current thread is not an open delegated task.' };
      }
      const request = AgentWaitRequest.create(input.seconds, input.reason);
      await updateJobTask(jobId, taskIndex, { waitReason: request.reason, wakeAt: request.wakeAt.getTime() });
      await agentTaskParkingService.park(jobId, taskIndex, request);
      return { successBoolean: true, responseString: `Parked. End your turn now; you will be woken at ${ request.wakeAt.toISOString() } or when your manager messages you.` };
    } catch (error) {
      return { successBoolean: false, responseString: (error as Error).message };
    }
  }
}

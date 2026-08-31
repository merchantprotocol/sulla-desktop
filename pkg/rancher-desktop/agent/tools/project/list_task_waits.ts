import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

import type { WorkTaskWaitStatus } from '../../database/models/WorkTaskWaitModel';

export class ListTaskWaitsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const waits = await getProjectsApplicationService().listWaits({
        taskId: typeof input.task_id === 'string' && input.task_id.trim() ? input.task_id.trim() : undefined,
        status: typeof input.status === 'string' && input.status.trim() ? input.status.trim() as WorkTaskWaitStatus : undefined,
        limit:  typeof input.limit === 'number' ? input.limit : undefined,
      });
      if (!waits.length) return { successBoolean: true, responseString: 'No task waits found.' };
      const lines = waits.map(wait =>
        `- [${ wait.status }] ${ wait.wait_kind } ${ wait.target_key } — task ${ wait.task_id }; next ${ wait.next_check_at }; unchanged ${ wait.consecutive_unchanged_count }; failures ${ wait.consecutive_failure_count } (id ${ wait.id })`,
      );
      return { successBoolean: true, responseString: `${ waits.length } task wait(s):\n${ lines.join('\n') }` };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Failed to list task waits: ${ err?.message }` };
    }
  }
}

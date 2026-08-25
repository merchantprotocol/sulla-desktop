import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

import type { WorkTaskWaitKind } from '../../database/models/WorkTaskWaitModel';

const WAIT_KINDS = new Set<WorkTaskWaitKind>(['github_checks', 'human_gate', 'scheduled_time', 'external_job']);

/** Register one deterministic external wait. Duplicate active targets are idempotent. */
export class RegisterTaskWaitWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const taskId = typeof input.task_id === 'string' ? input.task_id.trim() : '';
    const waitKind = typeof input.wait_kind === 'string' ? input.wait_kind.trim() as WorkTaskWaitKind : '' as WorkTaskWaitKind;
    const targetKey = typeof input.target_key === 'string' ? input.target_key.trim() : '';
    const target = input.target && typeof input.target === 'object' && !Array.isArray(input.target) ? input.target : null;
    if (!taskId || !WAIT_KINDS.has(waitKind) || !targetKey || !target) {
      return { successBoolean: false, responseString: 'task_id, valid wait_kind, target_key, and target object are required.' };
    }
    try {
      const dueAt = typeof input.due_at === 'string' && input.due_at.trim() ? input.due_at.trim() : null;
      const nextCheckAt = typeof input.next_check_at === 'string' && input.next_check_at.trim()
        ? input.next_check_at.trim()
        : (waitKind === 'human_gate' && dueAt ? dueAt : undefined);
      const actor = input.actor || 'sulla';
      const registration = await getProjectsApplicationService().registerWait({
        taskId,
        waitKind,
        targetKey,
        target,
        fingerprint: typeof input.fingerprint === 'string' ? input.fingerprint : undefined,
        nextCheckAt,
        dueAt,
        owner:       typeof input.owner === 'string' && input.owner.trim() ? input.owner.trim() : undefined,
      }, { actor, source: 'tool' });
      return {
        successBoolean: true,
        responseString: `${ registration.created ? 'Registered' : 'Existing' } ${ waitKind } wait ${ registration.wait.id } for task ${ taskId }; next check ${ registration.wait.next_check_at }.`,
      };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Failed to register task wait: ${ err?.message }` };
    }
  }
}

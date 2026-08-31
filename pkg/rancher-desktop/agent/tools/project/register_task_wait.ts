import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

import type { WorkTaskWaitKind } from '../../database/models/WorkTaskWaitModel';

const WAIT_KINDS = new Set<WorkTaskWaitKind>(['github_checks', 'human_gate', 'scheduled_time', 'external_job']);

const MONITOR_RECHECK_MS = 5 * 60 * 1000;

export function resolveNextCheckAt(waitKind: WorkTaskWaitKind, nextCheckAt: unknown, dueAt: string | null, now = Date.now()): string | undefined {
  if (typeof nextCheckAt === 'string' && nextCheckAt.trim()) return nextCheckAt.trim();
  if (waitKind === 'human_gate' && dueAt) return new Date(now + MONITOR_RECHECK_MS).toISOString();
  return undefined;
}

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
      // A due date is the human gate's deadline, not its monitor schedule.
      // Keep the monitor alive on its normal cadence while preserving due_at separately.
      const nextCheckAt = resolveNextCheckAt(waitKind, input.next_check_at, dueAt);
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

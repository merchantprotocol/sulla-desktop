import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

const OUTCOMES = new Set(['satisfied', 'failed']);

/** Settle one durable external wait a workflow node already holds evidence for. */
export class SettleTaskWaitWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    const outcome = typeof input.outcome === 'string' ? input.outcome.trim() : '';
    const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
    if (!id || !OUTCOMES.has(outcome) || !summary) {
      return { successBoolean: false, responseString: 'id, outcome (satisfied|failed), and summary are required.' };
    }
    try {
      const actor = typeof input.actor === 'string' && input.actor.trim() ? input.actor.trim() : 'sulla';
      const result = await getProjectsApplicationService().settleWait({
        id,
        outcome:      outcome as 'satisfied' | 'failed',
        summary,
        fingerprint:  typeof input.fingerprint === 'string' ? input.fingerprint : undefined,
        nextCheckAt:  typeof input.next_check_at === 'string' ? input.next_check_at : undefined,
      }, { actor, source: 'routine' });
      return { successBoolean: true, responseString: JSON.stringify(result, null, 2) };
    } catch (error: any) {
      return { successBoolean: false, responseString: `Failed to settle task wait: ${ error?.message ?? String(error) }` };
    }
  }
}

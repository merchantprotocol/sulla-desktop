import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

/** Attach one structured, generation-scoped artifact/evidence receipt to a task. */
export class AttachTaskEvidenceWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const taskId = typeof input.task_id === 'string' ? input.task_id.trim() : '';
    const eventType = typeof input.event_type === 'string' ? input.event_type.trim() : '';
    if (!taskId || !eventType) {
      return { successBoolean: false, responseString: 'task_id and event_type are required.' };
    }
    try {
      const result = await getProjectsApplicationService().attachEvidence({
        taskId,
        eventType,
        artifacts:          Array.isArray(input.artifacts) ? input.artifacts : undefined,
        contentHashes:      Array.isArray(input.content_hashes) ? input.content_hashes : undefined,
        evidenceKind:       typeof input.evidence_kind === 'string' ? input.evidence_kind : undefined,
        evidenceRef:        typeof input.evidence_ref === 'string' ? input.evidence_ref : undefined,
        evidenceUrl:        typeof input.evidence_url === 'string' ? input.evidence_url : undefined,
        disposition:        typeof input.disposition === 'string' ? input.disposition : undefined,
        validationSummary:  typeof input.validation_summary === 'string' ? input.validation_summary : undefined,
        expectedGeneration: typeof input.expected_generation === 'number' ? input.expected_generation : undefined,
      }, { actor: typeof input.actor === 'string' && input.actor.trim() ? input.actor.trim() : 'sulla', source: 'routine' });
      return { successBoolean: true, responseString: JSON.stringify(result, null, 2) };
    } catch (error: any) {
      return { successBoolean: false, responseString: `Failed to attach task evidence: ${ error?.message ?? String(error) }` };
    }
  }
}

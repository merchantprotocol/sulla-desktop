import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

/**
 * Soft-archive a project, epic, or task. Cascades down. Never hard-deletes.
 */
export class ArchiveProjectItemWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id) return { successBoolean: false, responseString: 'id is required.' };
    const hint = typeof input.kind === 'string' ? input.kind.trim().toLowerCase() : '';

    try {
      const projects = getProjectsApplicationService();
      await projects.ready();
      const tryKinds = (hint ? [hint] : ['task', 'epic', 'project']) as ('project' | 'epic' | 'task')[];
      for (const kind of tryKinds) {
        const ok = await projects.archive(kind, id, { actor: input.actor || 'sulla', source: 'tool' });
        if (ok) {
          return {
            successBoolean: true,
            responseString: `${ kind[0].toUpperCase() + kind.slice(1) } archived (soft-deleted): ${ id }${
              kind === 'project' ? ' (epics + tasks cascaded)' : kind === 'epic' ? ' (tasks cascaded)' : ''
            }`,
          };
        }
      }
      return { successBoolean: false, responseString: `No project item found with id: ${ id }` };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Failed to archive project item: ${ err?.message }` };
    }
  }
}

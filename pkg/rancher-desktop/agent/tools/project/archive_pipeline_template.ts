import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

/** Archive a custom pipeline template so it no longer appears for new projects. Core templates cannot be archived. */
export class ArchivePipelineTemplateWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const templateId = typeof input.template_id === 'string' ? input.template_id.trim() : '';
    if (!templateId) return { successBoolean: false, responseString: 'template_id is required.' };
    try {
      const template = await getProjectsApplicationService().archiveProjectPipelineTemplate(
        templateId, { actor: input.actor || 'sulla', source: 'tool' },
      );
      if (!template) return { successBoolean: false, responseString: `Pipeline template not found: ${ templateId }` };
      return { successBoolean: true, responseString: JSON.stringify(template, null, 2) };
    } catch (error: any) {
      return { successBoolean: false, responseString: `Failed to archive pipeline template: ${ error?.message ?? String(error) }` };
    }
  }
}

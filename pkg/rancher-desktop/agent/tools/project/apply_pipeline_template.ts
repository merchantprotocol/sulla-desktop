import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

export class ApplyPipelineTemplateWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const projectId = typeof input.project_id === 'string' ? input.project_id.trim() : '';
    const templateId = typeof input.template_id === 'string' ? input.template_id.trim() : '';
    if (!projectId || !templateId) {
      return { successBoolean: false, responseString: 'project_id and template_id are required.' };
    }
    try {
      const template = await getProjectsApplicationService().applyProjectPipelineTemplate(
        projectId, templateId, { actor: input.actor || 'sulla', source: 'tool' },
      );
      return { successBoolean: true, responseString: `Applied pipeline template ${ template.name } (${ template.id }) to project ${ projectId }.` };
    } catch (error: any) {
      return { successBoolean: false, responseString: `Failed to apply pipeline template: ${ error?.message ?? String(error) }` };
    }
  }
}

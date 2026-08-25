import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

export class ListPipelineTemplatesWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const projects = getProjectsApplicationService();
      if (typeof input.template_id === 'string' && input.template_id.trim()) {
        const template = await projects.getProjectPipelineTemplate(input.template_id.trim());
        return template
          ? { successBoolean: true, responseString: JSON.stringify(template, null, 2) }
          : { successBoolean: false, responseString: `Pipeline template not found: ${ input.template_id }` };
      }
      return {
        successBoolean: true,
        responseString: JSON.stringify(await projects.listProjectPipelineTemplates(Boolean(input.include_archived)), null, 2),
      };
    } catch (error: any) {
      return { successBoolean: false, responseString: `Failed to list pipeline templates: ${ error?.message ?? String(error) }` };
    }
  }
}

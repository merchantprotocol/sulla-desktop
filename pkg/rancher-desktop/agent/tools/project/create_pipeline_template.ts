import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

export class CreatePipelineTemplateWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const template = await getProjectsApplicationService().createProjectPipelineTemplate({
        templateKey: input.template_key,
        name: input.name,
        description: input.description,
        stages: Array.isArray(input.stages) ? input.stages.map((stage: any) => ({
          stageKey: stage.stage_key,
          displayName: stage.display_name,
          description: stage.description,
          position: stage.position,
          semanticRole: stage.semantic_role,
          workflowId: stage.workflow_id,
          entryPolicy: stage.entry_policy,
          wipLimit: stage.wip_limit,
        })) : [],
        actor: input.actor,
      }, { actor: input.actor || 'sulla', source: 'tool' });
      return { successBoolean: true, responseString: JSON.stringify(template, null, 2) };
    } catch (error: any) {
      return { successBoolean: false, responseString: `Failed to create pipeline template: ${ error?.message ?? String(error) }` };
    }
  }
}

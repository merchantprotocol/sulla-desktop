import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

/** Rename/re-describe a custom pipeline template and/or replace its ordered stage set. Core templates cannot be edited. */
export class UpdatePipelineTemplateWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const templateId = typeof input.template_id === 'string' ? input.template_id.trim() : '';
    if (!templateId) return { successBoolean: false, responseString: 'template_id is required.' };
    try {
      const template = await getProjectsApplicationService().updateProjectPipelineTemplate(templateId, {
        name:        input.name,
        description: input.description,
        stages:      Array.isArray(input.stages)
          ? input.stages.map((stage: any) => ({
            stageKey:     stage.stage_key,
            displayName:  stage.display_name,
            description:  stage.description,
            position:     stage.position,
            semanticRole: stage.semantic_role,
            workflowId:   stage.workflow_id,
            entryPolicy:  stage.entry_policy,
            wipLimit:     stage.wip_limit,
          }))
          : undefined,
        actor: input.actor,
      }, { actor: input.actor || 'sulla', source: 'tool' });
      return { successBoolean: true, responseString: JSON.stringify(template, null, 2) };
    } catch (error: any) {
      return { successBoolean: false, responseString: `Failed to update pipeline template: ${ error?.message ?? String(error) }` };
    }
  }
}

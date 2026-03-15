import { BaseTool, ToolResponse } from '../base';
import { projectRegistry } from '../../database/registry/ProjectRegistry';

/**
 * Load Project Tool - Load the full PROJECT.md content for a project.
 */
export class LoadProjectWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { project_name } = input;
    const result = await projectRegistry.loadProject(project_name);
    return {
      successBoolean: true,
      responseString: result,
    };
  }
}

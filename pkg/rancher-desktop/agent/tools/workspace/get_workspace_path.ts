import { BaseTool, ToolResponse } from '../base';
import { resolveWorkspacePath } from './workspace_paths';

/**
 * Get Workspace Path Tool - Worker class for execution
 */
export class GetWorkspacePathWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { name } = input;
    const absoluteWorkspacePath = resolveWorkspacePath(name);
    return {
      successBoolean: true,
      responseString: absoluteWorkspacePath,
    };
  }
}

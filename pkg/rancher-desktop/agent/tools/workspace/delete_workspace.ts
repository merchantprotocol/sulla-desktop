import { BaseTool, ToolResponse } from '../base';
import fs from 'fs';
import { resolveWorkspacePath } from './workspace_paths';

/**
 * Delete Workspace Tool - Worker class for execution
 */
export class DeleteWorkspaceWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { name } = input;
    const absoluteWorkspacePath = resolveWorkspacePath(name);
    try {
      fs.rmSync(absoluteWorkspacePath, { recursive: true, force: true });
      return {
        successBoolean: true,
        responseString: `Workspace "${ name }" deleted successfully from ${ absoluteWorkspacePath }`,
      };
    } catch (error: any) {
      return {
        successBoolean: false,
        responseString: `Failed to delete workspace "${ name }": ${ error.message }`,
      };
    }
  }
}

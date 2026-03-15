import { BaseTool, ToolResponse } from '../base';
import fs from 'fs';
import { resolveWorkspacePath, resolveWorkspaceRoot } from './workspace_paths';

/**
 * Create Workspace Tool - Worker class for execution
 */
export class CreateWorkspaceWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { name } = input;
    const workspaceRoot = resolveWorkspaceRoot();
    const absoluteWorkspacePath = resolveWorkspacePath(name);
    try {
      fs.mkdirSync(workspaceRoot, { recursive: true });
      fs.mkdirSync(absoluteWorkspacePath, { recursive: true });
      return {
        successBoolean: true,
        responseString: `Workspace "${ name }" created successfully at ${ absoluteWorkspacePath }`,
      };
    } catch (error: any) {
      return {
        successBoolean: false,
        responseString: `Failed to create workspace "${ name }": ${ error.message }`,
      };
    }
  }
}

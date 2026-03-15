import { BaseTool, ToolResponse } from '../base';
import fs from 'fs';
import { resolveWorkspacePath } from './workspace_paths';

/**
 * View Workspace Files Tool - Worker class for execution
 */
export class ViewWorkspaceFilesWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { name } = input;
    const absoluteWorkspacePath = resolveWorkspacePath(name);
    try {
      const entries = fs.readdirSync(absoluteWorkspacePath, { withFileTypes: true });
      const files = entries.map((entry) => `${ entry.isDirectory() ? 'd' : '-' } ${ entry.name }`);
      return {
        successBoolean: true,
        responseString: `Files in workspace "${ name }" (${ absoluteWorkspacePath }):\n${ files.join('\n') }`,
      };
    } catch (error: any) {
      return {
        successBoolean: false,
        responseString: `Failed to view workspace "${ name }": ${ error.message }`,
      };
    }
  }
}

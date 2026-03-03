import { BaseTool, ToolResponse } from "../base";
import { runCommand } from "../util/CommandRunner";

/**
 * GitHub Init Tool - Initialize a git repository at the specified path.
 * Runs inside the Lima VM for filesystem consistency with exec tool.
 */
export class GitHubInitWorker extends BaseTool {
  name: string = '';
  description: string = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { absolutePath } = input;

    try {
      // Check if already a git repo
      const checkResult = await runCommand(
        `git -C "${absolutePath}" rev-parse --git-dir`,
        [],
        { runInLimaShell: true, timeoutMs: 30_000 }
      );
      
      if (checkResult.exitCode === 0) {
        return { successBoolean: true, responseString: `Already a git repository at ${absolutePath}` };
      }

      // Ensure directory exists
      const mkdirResult = await runCommand(
        `mkdir -p "${absolutePath}"`,
        [],
        { runInLimaShell: true, timeoutMs: 30_000 }
      );
      
      if (mkdirResult.exitCode !== 0) {
        return { successBoolean: false, responseString: `Failed to create directory: ${mkdirResult.stderr || mkdirResult.stdout}` };
      }

      // Initialize the repository
      const cmd = `git -C "${absolutePath}" init`;
      const result = await runCommand(cmd, [], { runInLimaShell: true, timeoutMs: 30_000 });
      
      if (result.exitCode !== 0) {
        return { successBoolean: false, responseString: `Failed to initialize repository: ${result.stderr || result.stdout}` };
      }

      return { 
        successBoolean: true, 
        responseString: result.stdout.trim() || `Initialized empty Git repository in ${absolutePath}` 
      };
    } catch (error: any) {
      return { successBoolean: false, responseString: `Git init failed: ${error.message}` };
    }
  }
}

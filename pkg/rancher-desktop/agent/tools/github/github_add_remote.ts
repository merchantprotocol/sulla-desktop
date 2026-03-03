import { BaseTool, ToolResponse } from "../base";
import { runCommand } from "../util/CommandRunner";

/**
 * GitHub Add Remote Tool - Add a remote repository to an existing git repository.
 * Runs inside the Lima VM for filesystem consistency with exec tool.
 */
export class GitHubAddRemoteWorker extends BaseTool {
  name: string = '';
  description: string = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { absolutePath, remoteName, remoteUrl } = input;

    try {
      // Verify path is a git repo
      const rootResult = await runCommand(
        `git -C "${absolutePath}" rev-parse --show-toplevel`,
        [],
        { runInLimaShell: true, timeoutMs: 30_000 }
      );
      
      if (rootResult.exitCode !== 0) {
        return { successBoolean: false, responseString: `Not a git repository: ${absolutePath}` };
      }
      
      const repoRoot = rootResult.stdout.trim();

      // Check if remote already exists
      const checkResult = await runCommand(
        `git -C "${repoRoot}" remote get-url "${remoteName}"`,
        [],
        { runInLimaShell: true, timeoutMs: 30_000 }
      );
      
      if (checkResult.exitCode === 0) {
        return { successBoolean: false, responseString: `Remote '${remoteName}' already exists with URL: ${checkResult.stdout.trim()}` };
      }

      // Add the remote
      const cmd = `git -C "${repoRoot}" remote add "${remoteName}" "${remoteUrl}"`;
      const result = await runCommand(cmd, [], { runInLimaShell: true, timeoutMs: 30_000 });
      
      if (result.exitCode !== 0) {
        return { successBoolean: false, responseString: `Failed to add remote: ${result.stderr || result.stdout}` };
      }

      return { 
        successBoolean: true, 
        responseString: `Added remote '${remoteName}' with URL: ${remoteUrl}` 
      };
    } catch (error: any) {
      return { successBoolean: false, responseString: `Failed to add remote: ${error.message}` };
    }
  }
}

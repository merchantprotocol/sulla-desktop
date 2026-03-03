import { BaseTool, ToolResponse } from "../base";
import { runCommand } from "../util/CommandRunner";

/**
 * Git Stash Tool - Save, list, apply, pop, or drop stashed changes.
 * Runs inside the Lima VM for filesystem consistency with exec tool.
 */
export class GitStashWorker extends BaseTool {
  name: string = '';
  description: string = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { absolutePath, action, message, stashRef = 'stash@{0}' } = input;

    try {
      // Get repo root
      const rootResult = await runCommand(
        `git -C "${absolutePath}" rev-parse --show-toplevel`,
        [],
        { runInLimaShell: true, timeoutMs: 30_000 }
      );
      
      if (rootResult.exitCode !== 0) {
        return { successBoolean: false, responseString: `Git error: ${rootResult.stderr || rootResult.stdout}` };
      }
      
      const repoRoot = rootResult.stdout.trim();

      let cmd: string;
      switch (action) {
        case 'save':
          cmd = message 
            ? `git -C "${repoRoot}" stash push -m "${message}"`
            : `git -C "${repoRoot}" stash push`;
          break;
        case 'list':
          cmd = `git -C "${repoRoot}" stash list`;
          break;
        case 'apply':
          cmd = `git -C "${repoRoot}" stash apply "${stashRef}"`;
          break;
        case 'pop':
          cmd = `git -C "${repoRoot}" stash pop "${stashRef}"`;
          break;
        case 'drop':
          cmd = `git -C "${repoRoot}" stash drop "${stashRef}"`;
          break;
        default:
          return { successBoolean: false, responseString: `Invalid stash action: ${action}` };
      }

      const result = await runCommand(cmd, [], { runInLimaShell: true, timeoutMs: 30_000 });
      
      if (result.exitCode !== 0) {
        return { successBoolean: false, responseString: `Git stash ${action} failed: ${result.stderr || result.stdout}` };
      }

      const output = result.stdout.trim() || result.stderr.trim();
      return { 
        successBoolean: true, 
        responseString: output || `Stash ${action} completed successfully.` 
      };
    } catch (error: any) {
      return { successBoolean: false, responseString: `Git stash failed: ${error.message}` };
    }
  }
}

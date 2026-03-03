import { BaseTool, ToolResponse } from "../base";
import { runCommand } from "../util/CommandRunner";

/**
 * Git Status Tool - Show working tree status.
 * Runs inside the Lima VM for filesystem consistency with exec tool.
 */
export class GitStatusWorker extends BaseTool {
  name: string = '';
  description: string = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { absolutePath } = input;

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

      // Get current branch
      const branchResult = await runCommand(
        `git -C "${repoRoot}" rev-parse --abbrev-ref HEAD`,
        [],
        { runInLimaShell: true, timeoutMs: 30_000 }
      );
      const currentBranch = branchResult.stdout.trim() || '(unknown)';

      // Get status
      const statusResult = await runCommand(
        `git -C "${repoRoot}" status --porcelain`,
        [],
        { runInLimaShell: true, timeoutMs: 30_000 }
      );

      const lines = statusResult.stdout.trim().split('\n').filter(Boolean);
      const staged: string[] = [];
      const unstaged: string[] = [];
      const untracked: string[] = [];

      for (const line of lines) {
        const index = line[0];
        const worktree = line[1];
        const file = line.slice(3);

        if (index === '?') {
          untracked.push(file);
        } else {
          if (index !== ' ' && index !== '?') staged.push(file);
          if (worktree !== ' ' && worktree !== '?') unstaged.push(file);
        }
      }

      let output = `Repository: ${repoRoot}\nCurrent branch: ${currentBranch}\n`;
      if (staged.length) output += `\nStaged files (${staged.length}):\n  ${staged.join('\n  ')}`;
      if (unstaged.length) output += `\nUnstaged changes (${unstaged.length}):\n  ${unstaged.join('\n  ')}`;
      if (untracked.length) output += `\nUntracked files (${untracked.length}):\n  ${untracked.join('\n  ')}`;
      if (!staged.length && !unstaged.length && !untracked.length) output += '\nWorking tree clean.';

      return { successBoolean: true, responseString: output };
    } catch (error: any) {
      return { successBoolean: false, responseString: `Git status failed: ${error.message}` };
    }
  }
}

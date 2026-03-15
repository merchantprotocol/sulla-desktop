import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';

/**
 * Git Push Tool - Push commits to a remote repository.
 * Runs inside the Lima VM for filesystem consistency with exec tool.
 */
export class GitPushWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { absolutePath, remote = 'origin', branch } = input;

    try {
      // Get repo root
      const rootResult = await runCommand(
        `git -C "${ absolutePath }" rev-parse --show-toplevel`,
        [],
        { runInLimaShell: true, timeoutMs: 30_000 },
      );

      if (rootResult.exitCode !== 0) {
        return { successBoolean: false, responseString: `Git error: ${ rootResult.stderr || rootResult.stdout }` };
      }

      const repoRoot = rootResult.stdout.trim();

      // Get current branch if not specified
      let targetBranch = branch;
      if (!targetBranch) {
        const branchResult = await runCommand(
          `git -C "${ repoRoot }" rev-parse --abbrev-ref HEAD`,
          [],
          { runInLimaShell: true, timeoutMs: 30_000 },
        );
        targetBranch = branchResult.stdout.trim();
      }

      const cmd = `git -C "${ repoRoot }" push ${ remote } ${ targetBranch }`;
      const result = await runCommand(cmd, [], { runInLimaShell: true, timeoutMs: 120_000 });

      if (result.exitCode !== 0) {
        return { successBoolean: false, responseString: `Git push failed: ${ result.stderr || result.stdout }` };
      }

      return {
        successBoolean: true,
        responseString: result.stderr.trim() || result.stdout.trim() || `Pushed to ${ remote }/${ targetBranch }`,
      };
    } catch (error: any) {
      return { successBoolean: false, responseString: `Git push failed: ${ error.message }` };
    }
  }
}

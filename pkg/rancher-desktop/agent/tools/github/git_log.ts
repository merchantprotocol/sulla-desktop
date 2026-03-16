import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';

/**
 * Git Log Tool - Show commit history.
 * Runs inside the Lima VM for filesystem consistency with exec tool.
 */
export class GitLogWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { absolutePath, limit = 20, oneline = true } = input;

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

      const format = oneline
        ? '--oneline'
        : '--pretty=format:"%h %ad | %s [%an]" --date=short';

      const cmd = `git -C "${ repoRoot }" log ${ format } -n ${ limit }`;
      const result = await runCommand(cmd, [], { runInLimaShell: true, timeoutMs: 30_000 });

      if (result.exitCode !== 0) {
        return { successBoolean: false, responseString: `Git log failed: ${ result.stderr || result.stdout }` };
      }

      return { successBoolean: true, responseString: `Commit history (last ${ limit }):\n${ result.stdout.trim() }` };
    } catch (error: any) {
      return { successBoolean: false, responseString: `Git log failed: ${ error.message }` };
    }
  }
}

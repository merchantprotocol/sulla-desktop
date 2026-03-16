import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';

/**
 * Git Conflicts Tool - List files with merge conflicts and show the conflict diffs.
 * Runs inside the Lima VM for filesystem consistency with exec tool.
 */
export class GitConflictsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { absolutePath } = input;

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

      // Find files with conflicts
      const conflictCmd = `git -C "${ repoRoot }" diff --name-only --diff-filter=U`;
      const conflictResult = await runCommand(conflictCmd, [], { runInLimaShell: true, timeoutMs: 30_000 });

      if (conflictResult.exitCode !== 0) {
        return { successBoolean: false, responseString: `Git conflicts check failed: ${ conflictResult.stderr || conflictResult.stdout }` };
      }

      const conflictFiles = conflictResult.stdout.trim().split('\n').filter(Boolean);

      if (conflictFiles.length === 0) {
        return { successBoolean: true, responseString: 'No merge conflicts found.' };
      }

      // Get conflict details for each file
      let output = `Found ${ conflictFiles.length } file(s) with conflicts:\n\n`;

      for (const file of conflictFiles) {
        output += `=== ${ file } ===\n`;
        const diffCmd = `git -C "${ repoRoot }" diff "${ file }"`;
        const diffResult = await runCommand(diffCmd, [], { runInLimaShell: true, timeoutMs: 30_000 });
        output += diffResult.stdout.trim() + '\n\n';
      }

      return { successBoolean: true, responseString: output.trim() };
    } catch (error: any) {
      return { successBoolean: false, responseString: `Git conflicts failed: ${ error.message }` };
    }
  }
}

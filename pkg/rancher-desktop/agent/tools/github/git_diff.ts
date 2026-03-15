import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';

/**
 * Git Diff Tool - Show changes between working tree, staging area, or commits.
 * Runs inside the Lima VM for filesystem consistency with exec tool.
 */
export class GitDiffWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { absolutePath, staged, commitA, commitB, filePath } = input;

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

      let cmd = `git -C "${ repoRoot }" diff`;

      if (staged) {
        cmd += ' --cached';
      } else if (commitA && commitB) {
        cmd += ` ${ commitA } ${ commitB }`;
      } else if (commitA) {
        cmd += ` ${ commitA }`;
      }

      if (filePath) {
        cmd += ` -- "${ filePath }"`;
      }

      const result = await runCommand(cmd, [], { runInLimaShell: true, timeoutMs: 60_000 });

      if (result.exitCode !== 0) {
        return { successBoolean: false, responseString: `Git diff failed: ${ result.stderr || result.stdout }` };
      }

      const output = result.stdout.trim();
      if (!output) {
        return { successBoolean: true, responseString: 'No differences found.' };
      }

      return { successBoolean: true, responseString: output };
    } catch (error: any) {
      return { successBoolean: false, responseString: `Git diff failed: ${ error.message }` };
    }
  }
}

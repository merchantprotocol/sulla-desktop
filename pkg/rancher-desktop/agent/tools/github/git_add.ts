import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';

/**
 * Git Add Tool - Stage files for commit.
 * Runs inside the Lima VM for filesystem consistency with exec tool.
 */
export class GitAddWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { absolutePath, files } = input;

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

      let cmd: string;
      if (files && Array.isArray(files) && files.length > 0) {
        const fileList = files.map((f: string) => `"${ f }"`).join(' ');
        cmd = `git -C "${ repoRoot }" add ${ fileList }`;
      } else {
        cmd = `git -C "${ repoRoot }" add -A`;
      }

      const result = await runCommand(cmd, [], { runInLimaShell: true, timeoutMs: 30_000 });

      if (result.exitCode !== 0) {
        return { successBoolean: false, responseString: `Git add failed: ${ result.stderr || result.stdout }` };
      }

      const stagedMsg = files && files.length > 0
        ? `Staged ${ files.length } file(s): ${ files.join(', ') }`
        : 'Staged all changes';

      return { successBoolean: true, responseString: stagedMsg };
    } catch (error: any) {
      return { successBoolean: false, responseString: `Git add failed: ${ error.message }` };
    }
  }
}

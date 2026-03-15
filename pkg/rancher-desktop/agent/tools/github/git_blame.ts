import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';

/**
 * Git Blame Tool - Show who last modified each line of a file.
 * Runs inside the Lima VM for filesystem consistency with exec tool.
 */
export class GitBlameWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { absolutePath, startLine, endLine } = input;

    try {
      let cmd = `git blame "${ absolutePath }"`;

      if (startLine && endLine) {
        cmd = `git blame -L ${ startLine },${ endLine } "${ absolutePath }"`;
      } else if (startLine) {
        cmd = `git blame -L ${ startLine }, "${ absolutePath }"`;
      }

      const result = await runCommand(cmd, [], { runInLimaShell: true, timeoutMs: 60_000 });

      if (result.exitCode !== 0) {
        return { successBoolean: false, responseString: `Git blame failed: ${ result.stderr || result.stdout }` };
      }

      return { successBoolean: true, responseString: result.stdout.trim() };
    } catch (error: any) {
      return { successBoolean: false, responseString: `Git blame failed: ${ error.message }` };
    }
  }
}

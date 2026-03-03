import { BaseTool, ToolResponse } from "../base";
import { runCommand } from "../util/CommandRunner";

/**
 * Git Commit Tool - Stage files and create a commit.
 * Runs inside the Lima VM for filesystem consistency with exec tool.
 */
export class GitCommitWorker extends BaseTool {
  name: string = '';
  description: string = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { absolutePath, message, files } = input;

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

      // Stage files
      let addCmd: string;
      if (!files || files.length === 0) {
        addCmd = `git -C "${repoRoot}" add -A`;
      } else {
        const fileArgs = files.map((f: string) => `"${f}"`).join(' ');
        addCmd = `git -C "${repoRoot}" add ${fileArgs}`;
      }

      const addResult = await runCommand(addCmd, [], { runInLimaShell: true, timeoutMs: 30_000 });
      if (addResult.exitCode !== 0) {
        return { successBoolean: false, responseString: `Git add failed: ${addResult.stderr || addResult.stdout}` };
      }

      // Commit
      const escapedMessage = message.replace(/"/g, '\\"');
      const commitCmd = `git -C "${repoRoot}" commit -m "${escapedMessage}"`;
      const commitResult = await runCommand(commitCmd, [], { runInLimaShell: true, timeoutMs: 30_000 });

      if (commitResult.exitCode !== 0) {
        const output = commitResult.stderr || commitResult.stdout;
        if (output.includes('nothing to commit')) {
          return { successBoolean: true, responseString: 'Nothing to commit, working tree clean.' };
        }
        return { successBoolean: false, responseString: `Git commit failed: ${output}` };
      }

      // Get commit hash
      const hashResult = await runCommand(
        `git -C "${repoRoot}" rev-parse --short HEAD`,
        [],
        { runInLimaShell: true, timeoutMs: 30_000 }
      );
      const hash = hashResult.stdout.trim();

      return { successBoolean: true, responseString: `Committed ${hash}: ${message}` };
    } catch (error: any) {
      return { successBoolean: false, responseString: `Git commit failed: ${error.message}` };
    }
  }
}

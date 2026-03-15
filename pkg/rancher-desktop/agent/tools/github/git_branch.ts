import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';

/**
 * Git Branch Tool - Create, switch, delete, or list branches.
 * Runs inside the Lima VM for filesystem consistency with exec tool.
 */
export class GitBranchWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { absolutePath, action } = input;
    const branchName = input.branchName || '';

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
      switch (action) {
      case 'list':
        cmd = `git -C "${ repoRoot }" branch -a --no-color`;
        break;
      case 'create':
        if (!branchName) return { successBoolean: false, responseString: 'branchName is required for create.' };
        cmd = `git -C "${ repoRoot }" checkout -b "${ branchName }"`;
        break;
      case 'switch':
        if (!branchName) return { successBoolean: false, responseString: 'branchName is required for switch.' };
        cmd = `git -C "${ repoRoot }" checkout "${ branchName }"`;
        break;
      case 'delete':
        if (!branchName) return { successBoolean: false, responseString: 'branchName is required for delete.' };
        cmd = `git -C "${ repoRoot }" branch -d "${ branchName }"`;
        break;
      default:
        return { successBoolean: false, responseString: `Unknown action '${ action }'. Use: list, create, switch, delete.` };
      }

      const result = await runCommand(cmd, [], { runInLimaShell: true, timeoutMs: 30_000 });

      if (result.exitCode !== 0) {
        return { successBoolean: false, responseString: `Git branch failed: ${ result.stderr || result.stdout }` };
      }

      if (action === 'list') {
        return { successBoolean: true, responseString: `Branches in ${ repoRoot }:\n${ result.stdout.trim() }` };
      } else if (action === 'create') {
        return { successBoolean: true, responseString: `Created and switched to branch '${ branchName }' in ${ repoRoot }` };
      } else if (action === 'switch') {
        return { successBoolean: true, responseString: `Switched to branch '${ branchName }' in ${ repoRoot }` };
      } else {
        return { successBoolean: true, responseString: result.stdout.trim() || `Deleted branch '${ branchName }'` };
      }
    } catch (error: any) {
      return { successBoolean: false, responseString: `Git branch failed: ${ error.message }` };
    }
  }
}

import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';

/**
 * Git Worktree Tool - Add, list, remove, or prune linked working trees.
 * Runs inside the Lima VM for filesystem consistency with the exec tool.
 *
 * Worktrees let you check out multiple branches of one repo into separate
 * directories simultaneously — the standard way to review/build several PRs in
 * parallel without stashing or disturbing the primary checkout.
 */
export class GitWorktreeWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const {
      absolutePath,
      action,
      worktreePath = '',
      branch = '',
      createBranch = false,
      commitish = '',
      force = false,
    } = input;

    try {
      // Resolve repo root (any path inside the repo works).
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
        cmd = `git -C "${ repoRoot }" worktree list --porcelain`;
        break;
      case 'add':
        if (!worktreePath) {
          return { successBoolean: false, responseString: 'worktreePath is required for add.' };
        }
        if (createBranch) {
          // Create a NEW branch in the new worktree, optionally based on commitish.
          if (!branch) {
            return { successBoolean: false, responseString: 'branch is required when createBranch is true.' };
          }
          cmd = `git -C "${ repoRoot }" worktree add -b "${ branch }" "${ worktreePath }"${ commitish ? ` "${ commitish }"` : '' }`;
        } else if (branch) {
          // Check out an EXISTING branch (or any commit-ish) into the new worktree.
          cmd = `git -C "${ repoRoot }" worktree add "${ worktreePath }" "${ branch }"`;
        } else {
          // Detached worktree at HEAD (or commitish).
          cmd = `git -C "${ repoRoot }" worktree add --detach "${ worktreePath }"${ commitish ? ` "${ commitish }"` : '' }`;
        }
        break;
      case 'remove':
        if (!worktreePath) {
          return { successBoolean: false, responseString: 'worktreePath is required for remove.' };
        }
        cmd = `git -C "${ repoRoot }" worktree remove${ force ? ' --force' : '' } "${ worktreePath }"`;
        break;
      case 'prune':
        cmd = `git -C "${ repoRoot }" worktree prune -v`;
        break;
      default:
        return { successBoolean: false, responseString: `Unknown action '${ action }'. Use: add, list, remove, prune.` };
      }

      const result = await runCommand(cmd, [], { runInLimaShell: true, timeoutMs: 60_000 });
      if (result.exitCode !== 0) {
        return { successBoolean: false, responseString: `Git worktree ${ action } failed: ${ result.stderr || result.stdout }` };
      }

      switch (action) {
      case 'list':
        return { successBoolean: true, responseString: `Worktrees for ${ repoRoot }:\n${ result.stdout.trim() }` };
      case 'add':
        return { successBoolean: true, responseString: `Added worktree at ${ worktreePath }${ branch ? ` (${ createBranch ? 'new branch' : 'branch' } ${ branch })` : ' (detached)' }.\n${ result.stdout.trim() }` };
      case 'remove':
        return { successBoolean: true, responseString: `Removed worktree ${ worktreePath }.${ result.stdout.trim() ? `\n${ result.stdout.trim() }` : '' }` };
      default:
        return { successBoolean: true, responseString: result.stdout.trim() || 'Pruned stale worktree entries.' };
      }
    } catch (error: any) {
      return { successBoolean: false, responseString: `Git worktree failed: ${ error.message }` };
    }
  }
}

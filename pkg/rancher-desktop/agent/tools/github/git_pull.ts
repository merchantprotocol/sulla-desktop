import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';

/**
 * Git Pull Tool - Pull commits from a remote repository.
 * Runs inside the Lima VM for filesystem consistency with exec tool.
 */
export class GitPullWorker extends BaseTool {
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

      // Fetch PAT from vault and build authenticated pull target for GitHub remotes
      let pullRemote = remote;
      const integrationService = getIntegrationService();
      const tokenValue = await integrationService.getIntegrationValue('github', 'token');
      const token = tokenValue?.value;

      if (token) {
        const remoteUrlResult = await runCommand(
          `git -C "${ repoRoot }" remote get-url ${ remote }`,
          [],
          { runInLimaShell: true, timeoutMs: 10_000 },
        );
        const rawUrl = remoteUrlResult.stdout.trim();

        if (rawUrl.includes('github.com')) {
          let httpsUrl = rawUrl;
          if (httpsUrl.startsWith('git@github.com:')) {
            httpsUrl = `https://github.com/${ httpsUrl.slice('git@github.com:'.length) }`;
          }
          if (httpsUrl.startsWith('https://github.com/')) {
            httpsUrl = `https://x-access-token:${ token }@github.com/${ httpsUrl.slice('https://github.com/'.length) }`;
          }
          pullRemote = `"${ httpsUrl }"`;
        }
      }

      // Build pull command
      let cmd = `git -C "${ repoRoot }" pull ${ pullRemote }`;
      if (branch) {
        cmd += ` ${ branch }`;
      }

      const result = await runCommand(cmd, [], { runInLimaShell: true, timeoutMs: 120_000 });

      if (result.exitCode !== 0) {
        // Check for merge conflicts
        const conflictCheck = await runCommand(
          `git -C "${ repoRoot }" diff --name-only --diff-filter=U`,
          [],
          { runInLimaShell: true, timeoutMs: 30_000 },
        );

        if (conflictCheck.stdout.trim()) {
          const conflictFiles = conflictCheck.stdout.trim().split('\n');
          return {
            successBoolean: false,
            responseString: `Pull completed with merge conflicts in ${ conflictFiles.length } file(s):\n${ conflictFiles.join('\n') }\n\nUse git_conflicts to see details.`,
          };
        }

        return { successBoolean: false, responseString: `Git pull failed: ${ result.stderr || result.stdout }` };
      }

      return { successBoolean: true, responseString: result.stdout.trim() || 'Pull completed successfully.' };
    } catch (error: any) {
      return { successBoolean: false, responseString: `Git pull failed: ${ error.message }` };
    }
  }
}

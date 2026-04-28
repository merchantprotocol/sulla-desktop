import { getIntegrationService } from '../../services/IntegrationService';
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
    const { absolutePath, remote = 'origin', branch, tags = false } = input;

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

      // Fetch PAT from vault and build authenticated push target for GitHub remotes
      let pushTarget = remote;
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
          pushTarget = `"${ httpsUrl }"`;
        }
      }

      const cmd = tags
        ? `git -C "${ repoRoot }" push ${ pushTarget } --tags`
        : `git -C "${ repoRoot }" push ${ pushTarget } ${ targetBranch }`;
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

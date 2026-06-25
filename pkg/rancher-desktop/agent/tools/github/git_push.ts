import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';

/**
 * Git Push Tool - Push commits to a remote repository.
 * Runs inside the Lima VM for filesystem consistency with exec tool.
 *
 * Auth: the GitHub PAT is supplied via an ephemeral credential helper reading
 * `GH_PAT` from the env — NOT embedded in the remote URL — so git's error/status
 * output (which echoes the remote URL) can never leak it. `redact()` scrubs the
 * token from anything we return, and `-c credential.helper=` resets the inherited
 * host `gh` helper (absent in the VM) to avoid its `gh: not found` noise.
 * Mirrors git_pull.ts.
 */
export class GitPushWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { absolutePath, remote = 'origin', branch, tags = false, force = false } = input;

    const redact = (s: string, secret?: string): string =>
      secret ? (s || '').split(secret).join('***') : (s || '');

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

      // Fetch PAT from vault and build an authenticated (token-free-on-the-wire)
      // push target for GitHub remotes.
      let pushTarget = remote;
      let authPrefix = '';
      let credFlags = '';
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
          // NOTE: no token in the URL — see class docstring.
          pushTarget = `"${ httpsUrl }"`;

          const helper =
            `'!f(){ test "$1" = get && printf "username=x-access-token\\npassword=%s\\n" "$GH_PAT"; }; f'`;
          credFlags = `-c credential.helper= -c credential.helper=${ helper } `;
          authPrefix = `GH_PAT='${ token }' GIT_TERMINAL_PROMPT=0 `;
        }
      }

      const forceFlag = force ? ' --force-with-lease' : '';
      const cmd = tags
        ? `${ authPrefix }git ${ credFlags }-C "${ repoRoot }" push ${ pushTarget } --tags${ forceFlag }`
        : `${ authPrefix }git ${ credFlags }-C "${ repoRoot }" push ${ pushTarget } ${ targetBranch }${ forceFlag }`;
      const result = await runCommand(cmd, [], { runInLimaShell: true, timeoutMs: 120_000 });

      if (result.exitCode !== 0) {
        return { successBoolean: false, responseString: redact(`Git push failed: ${ result.stderr || result.stdout }`, token) };
      }

      return {
        successBoolean: true,
        responseString: redact(result.stderr.trim() || result.stdout.trim() || `Pushed to ${ remote }/${ targetBranch }`, token),
      };
    } catch (error: any) {
      return { successBoolean: false, responseString: `Git push failed: ${ error.message }` };
    }
  }
}

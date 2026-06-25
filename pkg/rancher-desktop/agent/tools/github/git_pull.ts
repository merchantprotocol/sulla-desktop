import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';

/**
 * Git Pull Tool - Pull commits from a remote repository.
 * Runs inside the Lima VM for filesystem consistency with exec tool.
 *
 * Auth: the GitHub PAT is supplied to git via an ephemeral credential helper
 * that reads it from the `GH_PAT` env var (set inline on the git invocation).
 * The token is deliberately NOT embedded in the remote URL, so git's own error
 * messages (which echo the remote URL) can never leak it. As defense-in-depth,
 * `redact()` strips the token from anything we return. We also reset any
 * inherited `credential.helper` (e.g. the host `gh` helper, which doesn't exist
 * in the VM and otherwise spews `gh: not found` noise) and force `--no-rebase`
 * so behaviour doesn't depend on the user's ambient `pull.rebase` config.
 */
export class GitPullWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { absolutePath, remote = 'origin', branch } = input;

    // Strip a secret from any string we hand back to the caller / logs.
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

      // Fetch PAT from vault and build an authenticated (but token-free-on-the-wire)
      // pull target for GitHub remotes.
      let pullRemote = remote;
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
          pullRemote = `"${ httpsUrl }"`;

          // Credential helper reads the PAT from $GH_PAT (set inline below). The
          // empty `credential.helper=` first resets any inherited helper list.
          const helper =
            `'!f(){ test "$1" = get && printf "username=x-access-token\\npassword=%s\\n" "$GH_PAT"; }; f'`;
          credFlags = `-c credential.helper= -c credential.helper=${ helper } `;
          authPrefix = `GH_PAT='${ token }' GIT_TERMINAL_PROMPT=0 `;
        }
      }

      // Build pull command. `--no-rebase --no-edit` keeps behaviour deterministic
      // (merge, not rebase) regardless of the user's pull.rebase setting.
      let cmd = `${ authPrefix }git ${ credFlags }-C "${ repoRoot }" pull --no-rebase --no-edit ${ pullRemote }`;
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

        return { successBoolean: false, responseString: redact(`Git pull failed: ${ result.stderr || result.stdout }`, token) };
      }

      return { successBoolean: true, responseString: redact(result.stdout.trim() || 'Pull completed successfully.', token) };
    } catch (error: any) {
      return { successBoolean: false, responseString: `Git pull failed: ${ error.message }` };
    }
  }
}

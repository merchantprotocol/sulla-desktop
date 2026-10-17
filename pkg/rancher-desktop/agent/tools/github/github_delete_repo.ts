import { createGitHubOctokit } from './octokit';
import { BaseTool, ToolResponse } from '../base';

/**
 * Permanently deletes a GitHub repository. This is irreversible. Requires
 * confirm:true AND confirm_name matching the repo name to prevent accidents.
 */
export class GitHubDeleteRepoWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const owner       = typeof input.owner === 'string' ? input.owner.trim() : '';
    const repo        = typeof input.repo === 'string' ? input.repo.trim() : '';
    const confirmName = typeof input.confirm_name === 'string' ? input.confirm_name.trim() : '';
    const confirm     = input.confirm === true;

    if (!owner || !repo) {
      return { successBoolean: false, responseString: 'Missing required fields: owner, repo.' };
    }

    if (!confirm || confirmName !== repo) {
      return {
        successBoolean: false,
        responseString:
          `Refusing to delete ${ owner }/${ repo } — this is PERMANENT and cannot be undone.\n` +
          `Re-call with {"confirm":true,"confirm_name":"${ repo }"} to proceed.`,
      };
    }

    const octokit = await createGitHubOctokit(this.executionContext);

    try {
      await octokit.repos.delete({ owner, repo });
      return {
        successBoolean: true,
        responseString: `Repository ${ owner }/${ repo } permanently deleted.`,
      };
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || String(err);
      return { successBoolean: false, responseString: `Delete repo failed: ${ msg }` };
    }
  }
}

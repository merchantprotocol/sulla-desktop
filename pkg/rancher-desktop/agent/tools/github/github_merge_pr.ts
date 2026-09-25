import { Octokit } from '@octokit/rest';

import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';

/**
 * GitHub Merge Pull Request. Destructive — PR is merged into the base
 * branch. Refuses without {"confirm":true}.
 */
export class GitHubMergePRWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const owner = typeof input.owner === 'string' ? input.owner.trim() : '';
    const repo  = typeof input.repo === 'string' ? input.repo.trim() : '';
    const pullNumber = typeof input.pull_number === 'number' ? input.pull_number : parseInt(String(input.pull_number || ''), 10);
    const mergeMethod = ['merge', 'squash', 'rebase'].includes(input.merge_method) ? input.merge_method : 'merge';
    const commitTitle   = typeof input.commit_title === 'string' ? input.commit_title : undefined;
    const commitMessage = typeof input.commit_message === 'string' ? input.commit_message : undefined;
    const confirm = input.confirm === true;
    const sha = typeof input.sha === 'string' ? input.sha.trim() : undefined;
    if (input.sha !== undefined && (!sha || !/^[a-f0-9]{40}$/i.test(sha))) {
      return { successBoolean: false, responseString: 'sha must be the full tested PR head SHA.' };
    }

    if (!owner || !repo) {
      return { successBoolean: false, responseString: 'Missing required fields: owner, repo.' };
    }
    if (!pullNumber || Number.isNaN(pullNumber)) {
      return { successBoolean: false, responseString: 'Missing or invalid "pull_number".' };
    }
    if (!confirm) {
      return {
        successBoolean: false,
        responseString:
          `Refusing to merge ${ owner }/${ repo }#${ pullNumber } without explicit confirmation. ` +
          `Re-call with {"confirm":true} to merge via "${ mergeMethod }".`,
      };
    }

    const integrationService = getIntegrationService();
    const tokenValue = await integrationService.getIntegrationValue('github', 'token');
    if (!tokenValue) {
      return { successBoolean: false, responseString: 'GitHub token not configured in vault.' };
    }

    const octokit = new Octokit({ auth: tokenValue.value });

    try {
      const response = await octokit.pulls.merge({
        owner,
        repo,
        pull_number:    pullNumber,
        merge_method:   mergeMethod,
        sha,
        commit_title:   commitTitle,
        commit_message: commitMessage,
      });

      if (!response.data.merged) {
        return { successBoolean: false, responseString: `Merge refused: ${ response.data.message }` };
      }
      return {
        successBoolean: true,
        responseString:
          `Merged ${ owner }/${ repo }#${ pullNumber } (${ mergeMethod }).\n` +
          `SHA: ${ response.data.sha }\n` +
          `Message: ${ response.data.message }`,
      };
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || String(err);
      return { successBoolean: false, responseString: `Merge failed: ${ msg }` };
    }
  }
}

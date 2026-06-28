import { Octokit } from '@octokit/rest';

import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';

export class GitHubClosePRWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const owner      = typeof input.owner === 'string' ? input.owner.trim() : '';
    const repo       = typeof input.repo === 'string' ? input.repo.trim() : '';
    const pullNumber = typeof input.pull_number === 'number' ? input.pull_number : parseInt(String(input.pull_number || ''), 10);
    const comment    = typeof input.comment === 'string' ? input.comment.trim() : '';
    const confirm    = input.confirm === true;

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
          `Refusing to close ${ owner }/${ repo }#${ pullNumber } without explicit confirmation.\n` +
          `Re-call with {"confirm":true} to close without merging.`,
      };
    }

    const integrationService = getIntegrationService();
    const tokenValue = await integrationService.getIntegrationValue('github', 'token');
    if (!tokenValue) {
      return { successBoolean: false, responseString: 'GitHub token not configured in vault.' };
    }

    const octokit = new Octokit({ auth: tokenValue.value });

    try {
      const { data: pr } = await octokit.pulls.update({
        owner,
        repo,
        pull_number: pullNumber,
        state: 'closed',
      });

      if (comment) {
        await octokit.issues.createComment({
          owner,
          repo,
          issue_number: pullNumber,
          body: comment,
        });
      }

      return {
        successBoolean: true,
        responseString:
          `PR #${ pr.number } "${ pr.title }" closed (not merged).\n` +
          `URL: ${ pr.html_url }` +
          (comment ? `\nComment posted.` : ''),
      };
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || String(err);
      return { successBoolean: false, responseString: `Close PR failed: ${ msg }` };
    }
  }
}

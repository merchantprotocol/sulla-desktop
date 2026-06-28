import { Octokit } from '@octokit/rest';

import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';

export class GitHubRequestPRReviewersWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const owner       = typeof input.owner === 'string' ? input.owner.trim() : '';
    const repo        = typeof input.repo === 'string' ? input.repo.trim() : '';
    const pullNumber  = typeof input.pull_number === 'number' ? input.pull_number : parseInt(String(input.pull_number || ''), 10);
    const reviewers   = Array.isArray(input.reviewers) ? input.reviewers.filter((r: any) => typeof r === 'string') : [];
    const teamReviewers = Array.isArray(input.team_reviewers) ? input.team_reviewers.filter((r: any) => typeof r === 'string') : [];

    if (!owner || !repo) {
      return { successBoolean: false, responseString: 'Missing required fields: owner, repo.' };
    }
    if (!pullNumber || Number.isNaN(pullNumber)) {
      return { successBoolean: false, responseString: 'Missing or invalid "pull_number".' };
    }
    if (reviewers.length === 0 && teamReviewers.length === 0) {
      return { successBoolean: false, responseString: 'Provide at least one reviewer in "reviewers" or "team_reviewers".' };
    }

    const integrationService = getIntegrationService();
    const tokenValue = await integrationService.getIntegrationValue('github', 'token');
    if (!tokenValue) {
      return { successBoolean: false, responseString: 'GitHub token not configured in vault.' };
    }

    const octokit = new Octokit({ auth: tokenValue.value });

    try {
      const { data: pr } = await octokit.pulls.requestReviewers({
        owner,
        repo,
        pull_number:     pullNumber,
        reviewers,
        team_reviewers:  teamReviewers,
      });

      const requested = pr.requested_reviewers?.map((r: any) => r.login).join(', ') || 'none';
      const teams     = pr.requested_teams?.map((t: any) => t.slug).join(', ') || 'none';

      return {
        successBoolean: true,
        responseString:
          `Reviewers requested on ${ owner }/${ repo }#${ pullNumber }.\n` +
          `Requested users: ${ requested }\n` +
          `Requested teams: ${ teams }`,
      };
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || String(err);
      return { successBoolean: false, responseString: `Request reviewers failed: ${ msg }` };
    }
  }
}

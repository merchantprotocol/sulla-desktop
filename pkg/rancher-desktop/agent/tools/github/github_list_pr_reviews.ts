import { Octokit } from '@octokit/rest';

import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';

export class GitHubListPRReviewsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const owner      = typeof input.owner === 'string' ? input.owner.trim() : '';
    const repo       = typeof input.repo === 'string' ? input.repo.trim() : '';
    const pullNumber = typeof input.pull_number === 'number' ? input.pull_number : parseInt(String(input.pull_number || ''), 10);

    if (!owner || !repo) {
      return { successBoolean: false, responseString: 'Missing required fields: owner, repo.' };
    }
    if (!pullNumber || Number.isNaN(pullNumber)) {
      return { successBoolean: false, responseString: 'Missing or invalid "pull_number".' };
    }

    const integrationService = getIntegrationService();
    const tokenValue = await integrationService.getIntegrationValue('github', 'token');
    if (!tokenValue) {
      return { successBoolean: false, responseString: 'GitHub token not configured in vault.' };
    }

    const octokit = new Octokit({ auth: tokenValue.value });

    try {
      const { data: reviews } = await octokit.pulls.listReviews({ owner, repo, pull_number: pullNumber });

      if (reviews.length === 0) {
        return { successBoolean: true, responseString: `No reviews yet on ${ owner }/${ repo }#${ pullNumber }.` };
      }

      const lines = reviews.map((r, i) =>
        `${ i + 1 }. ${ r.user?.login } — ${ r.state }\n` +
        `   Submitted: ${ r.submitted_at ? new Date(r.submitted_at).toLocaleString() : 'pending' }\n` +
        (r.body ? `   "${ r.body.slice(0, 200) }${ r.body.length > 200 ? '…' : '' }"` : '   (no comment)'),
      );

      const summary = reviews.reduce((acc: Record<string, number>, r) => {
        acc[r.state] = (acc[r.state] || 0) + 1;
        return acc;
      }, {});

      return {
        successBoolean: true,
        responseString:
          `${ reviews.length } reviews on ${ owner }/${ repo }#${ pullNumber }\n` +
          `Summary: ${ Object.entries(summary).map(([s, n]) => `${ n } ${ s }`).join(', ') }\n\n` +
          lines.join('\n\n'),
      };
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || String(err);
      return { successBoolean: false, responseString: `List PR reviews failed: ${ msg }` };
    }
  }
}

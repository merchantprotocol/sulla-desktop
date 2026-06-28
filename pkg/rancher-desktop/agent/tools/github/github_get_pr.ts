import { Octokit } from '@octokit/rest';

import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';

export class GitHubGetPRWorker extends BaseTool {
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
      const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: pullNumber });

      const reviewers = pr.requested_reviewers?.map((r: any) => r.login).join(', ') || 'none';
      const labels    = pr.labels?.map((l: any) => l.name).join(', ') || 'none';

      const lines = [
        `PR #${ pr.number }: ${ pr.title }`,
        `URL: ${ pr.html_url }`,
        `State: ${ pr.state }${ pr.draft ? ' (draft)' : '' }${ pr.merged ? ' (merged)' : '' }`,
        `Author: ${ pr.user?.login }`,
        `Head: ${ pr.head.ref } (${ pr.head.sha.slice(0, 8) }) → Base: ${ pr.base.ref }`,
        `Commits: ${ pr.commits }  |  Changed files: ${ pr.changed_files }  |  +${ pr.additions }/-${ pr.deletions }`,
        `Comments: ${ pr.comments }  |  Review comments: ${ pr.review_comments }`,
        `Reviewers: ${ reviewers }`,
        `Labels: ${ labels }`,
        `Mergeable: ${ pr.mergeable ?? 'unknown' }  |  Mergeable state: ${ pr.mergeable_state ?? 'unknown' }`,
        `Created: ${ new Date(pr.created_at).toLocaleString() }`,
        `Updated: ${ new Date(pr.updated_at).toLocaleString() }`,
        pr.body ? `\nDescription:\n${ pr.body }` : '',
      ].filter(Boolean);

      return { successBoolean: true, responseString: lines.join('\n') };
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || String(err);
      return { successBoolean: false, responseString: `Get PR failed: ${ msg }` };
    }
  }
}

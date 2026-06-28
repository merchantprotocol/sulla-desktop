import { Octokit } from '@octokit/rest';

import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';

export class GitHubListPRsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const owner  = typeof input.owner === 'string' ? input.owner.trim() : '';
    const repo   = typeof input.repo === 'string' ? input.repo.trim() : '';
    const state  = ['open', 'closed', 'all'].includes(input.state) ? input.state : 'open';
    const base   = typeof input.base === 'string' ? input.base.trim() : undefined;
    const head   = typeof input.head === 'string' ? input.head.trim() : undefined;
    const sort   = ['created', 'updated', 'popularity', 'long-running'].includes(input.sort) ? input.sort : 'updated';
    const limit  = typeof input.limit === 'number' ? Math.min(input.limit, 100) : 20;

    if (!owner || !repo) {
      return { successBoolean: false, responseString: 'Missing required fields: owner, repo.' };
    }

    const integrationService = getIntegrationService();
    const tokenValue = await integrationService.getIntegrationValue('github', 'token');
    if (!tokenValue) {
      return { successBoolean: false, responseString: 'GitHub token not configured in vault.' };
    }

    const octokit = new Octokit({ auth: tokenValue.value });

    try {
      const { data: prs } = await octokit.pulls.list({
        owner,
        repo,
        state:    state as any,
        base,
        head,
        sort:     sort as any,
        per_page: limit,
      });

      if (prs.length === 0) {
        return { successBoolean: true, responseString: `No ${ state } pull requests in ${ owner }/${ repo }.` };
      }

      const lines = prs.map((pr, i) => {
        const labels = pr.labels?.map((l: any) => l.name).join(', ');
        return (
          `${ i + 1 }. #${ pr.number } ${ pr.draft ? '[draft] ' : '' }${ pr.title }\n` +
          `   ${ pr.user?.login } · ${ pr.head.ref } → ${ pr.base.ref }\n` +
          `   State: ${ pr.state }  |  Reviews requested: ${ pr.requested_reviewers?.length || 0 }` +
          (labels ? `  |  Labels: ${ labels }` : '') + '\n' +
          `   Updated: ${ new Date(pr.updated_at).toLocaleDateString() }  |  ${ pr.html_url }`
        );
      });

      return {
        successBoolean: true,
        responseString: `${ prs.length } ${ state } pull requests in ${ owner }/${ repo }:\n\n${ lines.join('\n\n') }`,
      };
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || String(err);
      return { successBoolean: false, responseString: `List PRs failed: ${ msg }` };
    }
  }
}

import { Octokit } from '@octokit/rest';

import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';

export class GitHubListReposWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const owner   = typeof input.owner === 'string' ? input.owner.trim() : '';
    const type    = ['all', 'owner', 'member', 'public', 'private', 'forks', 'sources'].includes(input.type) ? input.type : 'all';
    const sort    = ['created', 'updated', 'pushed', 'full_name'].includes(input.sort) ? input.sort : 'updated';
    const limit   = typeof input.limit === 'number' ? input.limit : 20;
    const orgMode = input.org === true;

    const integrationService = getIntegrationService();
    const tokenValue = await integrationService.getIntegrationValue('github', 'token');
    if (!tokenValue) {
      return { successBoolean: false, responseString: 'GitHub token not configured in vault.' };
    }

    const octokit = new Octokit({ auth: tokenValue.value });

    try {
      let repos: any[];

      if (orgMode && owner) {
        const { data } = await octokit.repos.listForOrg({ org: owner, type: type as any, sort: sort as any, per_page: limit });
        repos = data;
      } else if (owner) {
        const { data } = await octokit.repos.listForUser({ username: owner, type: type as any, sort: sort as any, per_page: limit });
        repos = data;
      } else {
        const { data } = await octokit.repos.listForAuthenticatedUser({ type: type as any, sort: sort as any, per_page: limit });
        repos = data;
      }

      if (repos.length === 0) {
        return { successBoolean: true, responseString: 'No repositories found.' };
      }

      const lines = repos.map((r, i) =>
        `${ i + 1 }. ${ r.full_name }${ r.private ? ' [private]' : '' }${ r.fork ? ' [fork]' : '' }${ r.archived ? ' [archived]' : '' }\n` +
        `   ${ r.description || '(no description)' }\n` +
        `   Stars: ${ r.stargazers_count }  |  Lang: ${ r.language || '—' }  |  Pushed: ${ new Date(r.pushed_at).toLocaleDateString() }`,
      );

      return {
        successBoolean: true,
        responseString: `${ repos.length } repositories (sorted by ${ sort }):\n\n${ lines.join('\n\n') }`,
      };
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || String(err);
      return { successBoolean: false, responseString: `List repos failed: ${ msg }` };
    }
  }
}

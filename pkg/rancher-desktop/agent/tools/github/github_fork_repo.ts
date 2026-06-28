import { Octokit } from '@octokit/rest';

import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';

export class GitHubForkRepoWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const owner    = typeof input.owner === 'string' ? input.owner.trim() : '';
    const repo     = typeof input.repo === 'string' ? input.repo.trim() : '';
    const org      = typeof input.organization === 'string' ? input.organization.trim() : undefined;
    const newName  = typeof input.name === 'string' ? input.name.trim() : undefined;

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
      const { data: fork } = await octokit.repos.createFork({
        owner,
        repo,
        organization: org,
        name:         newName,
      });

      return {
        successBoolean: true,
        responseString:
          `Forked ${ owner }/${ repo } → ${ fork.full_name }\n` +
          `URL: ${ fork.html_url }\n` +
          `Clone: ${ fork.clone_url }`,
      };
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || String(err);
      return { successBoolean: false, responseString: `Fork failed: ${ msg }` };
    }
  }
}

import { Octokit } from '@octokit/rest';

import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';

export class GitHubCreateRepoWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const owner       = typeof input.owner === 'string' ? input.owner.trim() : '';
    const name        = typeof input.name === 'string' ? input.name.trim() : '';
    const description = typeof input.description === 'string' ? input.description : '';
    const isPrivate   = input.private === true;
    const autoInit    = input.auto_init !== false;
    const orgMode     = input.org === true;

    if (!name) {
      return { successBoolean: false, responseString: 'Missing required field: name.' };
    }

    const integrationService = getIntegrationService();
    const tokenValue = await integrationService.getIntegrationValue('github', 'token');
    if (!tokenValue) {
      return { successBoolean: false, responseString: 'GitHub token not configured in vault.' };
    }

    const octokit = new Octokit({ auth: tokenValue.value });

    try {
      let repo: any;

      if (orgMode && owner) {
        const response = await octokit.repos.createInOrg({
          org:         owner,
          name,
          description,
          private:     isPrivate,
          auto_init:   autoInit,
        });
        repo = response.data;
      } else {
        const response = await octokit.repos.createForAuthenticatedUser({
          name,
          description,
          private:   isPrivate,
          auto_init: autoInit,
        });
        repo = response.data;
      }

      return {
        successBoolean: true,
        responseString:
          `Repository created: ${ repo.full_name }\n` +
          `URL: ${ repo.html_url }\n` +
          `Clone: ${ repo.clone_url }\n` +
          `Private: ${ repo.private }\n` +
          `Default branch: ${ repo.default_branch }`,
      };
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || String(err);
      return { successBoolean: false, responseString: `Create repo failed: ${ msg }` };
    }
  }
}

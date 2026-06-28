import { Octokit } from '@octokit/rest';

import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';

export class GitHubUpdatePRWorker extends BaseTool {
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

    const patch: Record<string, any> = {};
    if (typeof input.title === 'string') patch.title = input.title;
    if (typeof input.body === 'string')  patch.body  = input.body;
    if (typeof input.base === 'string')  patch.base  = input.base;
    if (input.state === 'open' || input.state === 'closed') patch.state = input.state;

    if (Object.keys(patch).length === 0) {
      return { successBoolean: false, responseString: 'No fields to update. Provide at least one of: title, body, base, state.' };
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
        ...patch,
      });

      return {
        successBoolean: true,
        responseString:
          `PR #${ pr.number } updated.\n` +
          `Title: ${ pr.title }\n` +
          `State: ${ pr.state }  |  Head: ${ pr.head.ref } → Base: ${ pr.base.ref }\n` +
          `URL: ${ pr.html_url }`,
      };
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || String(err);
      return { successBoolean: false, responseString: `Update PR failed: ${ msg }` };
    }
  }
}

import { Octokit } from '@octokit/rest';

import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';

/**
 * GitHub Create Pull Request Tool
 */
export class GitHubCreatePRWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { owner, repo, title, head, base } = input;

    const integrationService = getIntegrationService();
    const tokenValue = await integrationService.getIntegrationValue('github', 'token');
    if (!tokenValue) {
      return {
        successBoolean: false,
        responseString: 'Error: GitHub token not configured.',
      };
    }

    const octokit = new Octokit({ auth: tokenValue.value });

    try {
      const response = await octokit.pulls.create({
        owner,
        repo,
        title,
        head,
        base:  base || 'main',
        body:  input.body || '',
        draft: input.draft === true,
      });

      const pr = response.data;
      return {
        successBoolean: true,
        responseString: `Pull request created: #${ pr.number } "${ pr.title }"\nURL: ${ pr.html_url }\nState: ${ pr.state }\nHead: ${ pr.head.ref } → Base: ${ pr.base.ref }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error creating pull request: ${ (error as Error).message }`,
      };
    }
  }
}

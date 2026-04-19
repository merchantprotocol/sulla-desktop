import { Octokit } from '@octokit/rest';

import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';

/**
 * GitHub Close Issue Tool
 */
export class GitHubCloseIssueWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { owner, repo, issue_number } = input;
    const reason = input.reason || 'completed';

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
      const response = await octokit.issues.update({
        owner,
        repo,
        issue_number,
        state:        'closed',
        state_reason: reason,
      });

      const issue = response.data;
      return {
        successBoolean: true,
        responseString: `Issue #${ issue.number } closed (${ reason }): "${ issue.title }"\nURL: ${ issue.html_url }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error closing issue: ${ (error as Error).message }`,
      };
    }
  }
}

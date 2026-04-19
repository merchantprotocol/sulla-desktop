import { Octokit } from '@octokit/rest';

import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';
/**
 * GitHub Comment on Issue Tool - Worker class for execution
 */
export class GitHubCommentOnIssueWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { owner, repo, issue_number, body } = input;

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
      const response = await octokit.issues.createComment({
        owner,
        repo,
        issue_number,
        body,
      });

      const responseString = `Comment added to issue #${ issue_number } in ${ owner }/${ repo }:
Comment ID: ${ response.data.id }
URL: ${ response.data.html_url }
Created by: ${ response.data.user?.login || 'Unknown' }
Created at: ${ new Date(response.data.created_at).toLocaleString() }
Body: ${ response.data.body }`;

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error commenting on issue: ${ (error as Error).message }`,
      };
    }
  }
}

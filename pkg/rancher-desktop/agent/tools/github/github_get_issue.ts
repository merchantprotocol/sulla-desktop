import { BaseTool, ToolResponse } from '../base';
import { Octokit } from '@octokit/rest';
import { getIntegrationService } from '../../services/IntegrationService';

/**
 * GitHub Get Issue Tool - Worker class for execution
 */
export class GitHubGetIssueWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { owner, repo, issue_number } = input;

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
      const response = await octokit.issues.get({
        owner,
        repo,
        issue_number,
      });

      const issue = response.data;

      // Format detailed issue information
      const labels = issue.labels.map((label: any) => typeof label === 'string' ? label : label.name).join(', ');
      const assignees = issue.assignees?.map(a => a.login).join(', ') || 'None';
      const createdDate = new Date(issue.created_at).toLocaleString();
      const updatedDate = new Date(issue.updated_at).toLocaleString();
      const closedDate = issue.closed_at ? new Date(issue.closed_at).toLocaleString() : 'N/A';

      const responseString = `Issue #${ issue.number }: ${ issue.title }
State: ${ issue.state }
Created by: ${ issue.user?.login || 'Unknown' }
Labels: ${ labels || 'None' }
Assignees: ${ assignees }
Created: ${ createdDate }
Updated: ${ updatedDate }
Closed: ${ closedDate }
Comments: ${ issue.comments }
Body:
${ issue.body || 'No description provided.' }`;

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error getting issue: ${ (error as Error).message }`,
      };
    }
  }
}

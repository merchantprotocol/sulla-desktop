import { Octokit } from '@octokit/rest';

import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';

/**
 * GitHub Get Issues Tool - Worker class for execution
 */
export class GitHubGetIssuesWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { owner, repo, state = 'open', labels, since, limit = 10 } = input;

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
      const response = await octokit.issues.listForRepo({
        owner,
        repo,
        state,
        labels:   labels?.join(','),
        since,
        per_page: limit,
      });

      const issues = response.data;
      if (!issues || issues.length === 0) {
        return {
          successBoolean: false,
          responseString: `No ${ state } issues found in ${ owner }/${ repo }${ labels ? ` with labels ${ labels.join(', ') }` : '' }.`,
        };
      }

      // Format detailed list of issues
      let responseString = `Issues in ${ owner }/${ repo } (${ state }${ labels ? `, labels: ${ labels.join(', ') }` : '' }):\n\n`;
      issues.forEach((issue, index) => {
        const labelsStr = issue.labels.map((label: any) => typeof label === 'string' ? label : label.name).join(', ') || 'None';
        const createdDate = new Date(issue.created_at).toLocaleString();
        const updatedDate = new Date(issue.updated_at).toLocaleString();
        responseString += `${ index + 1 }. #${ issue.number }: ${ issue.title }\n`;
        responseString += `   State: ${ issue.state }\n`;
        responseString += `   Created by: ${ issue.user?.login || 'Unknown' }\n`;
        responseString += `   Labels: ${ labelsStr }\n`;
        responseString += `   Created: ${ createdDate }\n`;
        responseString += `   Updated: ${ updatedDate }\n`;
        responseString += `   Comments: ${ issue.comments }\n\n`;
      });

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error getting issues: ${ (error as Error).message }`,
      };
    }
  }
}

import { BaseTool, ToolResponse } from '../base';
import { Octokit } from '@octokit/rest';
import { getIntegrationService } from '../../services/IntegrationService';

/**
 * GitHub Create File Tool - Worker class for execution
 */
export class GitHubCreateFileWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { owner, repo, path, content, message, branch } = input;

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
      const response = await octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        path,
        message,
        content: Buffer.from(content).toString('base64'),
        branch,
      });

      const responseString = `File created successfully:
Repository: ${ owner }/${ repo }
Path: ${ path }
Branch: ${ branch || 'default' }
Commit SHA: ${ response.data.commit.sha }
Commit URL: ${ response.data.commit.html_url }
Content SHA: ${ response.data.content?.sha || 'N/A' }`;

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error creating file: ${ (error as Error).message }`,
      };
    }
  }
}

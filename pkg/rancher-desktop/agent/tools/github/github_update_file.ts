import { Octokit } from '@octokit/rest';

import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';

/**
 * GitHub Update File Tool - Update an existing file in a GitHub repository
 */
export class GitHubUpdateFileWorker extends BaseTool {
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
      // First, get the current file to obtain its SHA (required for updates)
      let currentSha: string;
      try {
        const currentFile = await octokit.repos.getContent({
          owner,
          repo,
          path,
          ref: branch,
        });

        if (Array.isArray(currentFile.data)) {
          return {
            successBoolean: false,
            responseString: `Error: Path '${ path }' is a directory, not a file.`,
          };
        }

        if (currentFile.data.type !== 'file') {
          return {
            successBoolean: false,
            responseString: `Error: Path '${ path }' is not a file.`,
          };
        }

        currentSha = currentFile.data.sha;
      } catch (error: any) {
        if (error.status === 404) {
          return {
            successBoolean: false,
            responseString: `Error: File '${ path }' does not exist. Use github_create_file to create new files.`,
          };
        }
        throw error;
      }

      // Update the file with the new content
      const response = await octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        path,
        message,
        content: Buffer.from(content).toString('base64'),
        sha:     currentSha,
        branch,
      });

      const responseString = `File updated successfully:
Repository: ${ owner }/${ repo }
Path: ${ path }
Branch: ${ branch || 'default' }
Previous SHA: ${ currentSha }
New SHA: ${ response.data.content?.sha || 'N/A' }
Commit SHA: ${ response.data.commit.sha }
Commit URL: ${ response.data.commit.html_url }`;

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error updating file: ${ (error as Error).message }`,
      };
    }
  }
}

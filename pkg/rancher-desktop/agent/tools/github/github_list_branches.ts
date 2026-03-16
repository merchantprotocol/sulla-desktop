import { BaseTool, ToolResponse } from '../base';
import { Octokit } from '@octokit/rest';
import { getIntegrationService } from '../../services/IntegrationService';

/**
 * GitHub List Branches Tool - Worker class for execution
 */
export class GitHubListBranchesWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { owner, repo, protected: isProtected } = input;

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
      const response = await octokit.repos.listBranches({
        owner,
        repo,
        protected: isProtected,
      });

      const branches = response.data;
      if (!branches || branches.length === 0) {
        return {
          successBoolean: false,
          responseString: `No branches found in ${ owner }/${ repo }${ isProtected ? ' (protected only)' : '' }.`,
        };
      }

      // Format detailed list of branches
      let responseString = `Branches in ${ owner }/${ repo }${ isProtected ? ' (protected only)' : '' }:\n\n`;
      branches.forEach((branch, index) => {
        responseString += `${ index + 1 }. Name: ${ branch.name }\n`;
        responseString += `   SHA: ${ branch.commit.sha }\n`;
        responseString += `   Protected: ${ branch.protected ? 'Yes' : 'No' }\n\n`;
      });

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error listing branches: ${ (error as Error).message }`,
      };
    }
  }
}

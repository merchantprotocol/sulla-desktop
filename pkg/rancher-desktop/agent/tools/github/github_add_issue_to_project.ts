import { Octokit } from '@octokit/rest';

import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';

/**
 * GitHub Add Issue to Project (Projects V2) Tool — #500 step 5.
 *
 * Puts a discovered/triaged issue onto a Projects V2 board so it appears as a
 * card. Projects V2 is GraphQL-only (addProjectV2ItemById). The board is
 * addressed by its node id (projectId, PVT_… — from github_list_projects); the
 * issue by its node id (content_node_id). If the caller only has owner/repo/
 * number we resolve the node id via REST first. The mutation is idempotent: an
 * issue already on the board returns its existing item id rather than erroring,
 * so this is safe to call every triage cycle. Returns the item id (PVTI_…),
 * which github_set_project_field needs to move the card between columns.
 */
export class GitHubAddIssueToProjectWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { project_id: projectId } = input;
    if (!projectId) {
      return { successBoolean: false, responseString: 'Error: project_id (PVT_… board node id from github_list_projects) is required.' };
    }

    const integrationService = getIntegrationService();
    const tokenValue = await integrationService.getIntegrationValue('github', 'token');
    if (!tokenValue) {
      return { successBoolean: false, responseString: 'Error: GitHub token not configured.' };
    }

    const octokit = new Octokit({ auth: tokenValue.value });

    try {
      // Resolve the issue's GraphQL node id: prefer an explicit one, else REST owner/repo/number.
      let contentId: string | undefined = input.content_node_id;
      if (!contentId) {
        const { owner, repo } = input;
        const issueNumber = typeof input.issue_number === 'number'
          ? input.issue_number
          : parseInt(String(input.issue_number || ''), 10);
        if (!owner || !repo || !Number.isFinite(issueNumber)) {
          return { successBoolean: false, responseString: 'Error: provide content_node_id, or owner + repo + issue_number to resolve it.' };
        }
        const issue = await octokit.issues.get({ owner, repo, issue_number: issueNumber });
        contentId = (issue.data as any).node_id;
      }

      const res: any = await octokit.graphql(
        `mutation($project: ID!, $content: ID!) {
          addProjectV2ItemById(input: { projectId: $project, contentId: $content }) {
            item { id }
          }
        }`,
        { project: projectId, content: contentId },
      );

      const itemId = res?.addProjectV2ItemById?.item?.id;
      if (!itemId) {
        return { successBoolean: false, responseString: 'Error: mutation returned no item id.' };
      }
      return {
        successBoolean: true,
        responseString: `Added to board ${ projectId }.\n   itemId: ${ itemId }\n(Pass this itemId to github_set_project_field to set its Status/column.)`,
      };
    } catch (error) {
      return { successBoolean: false, responseString: `Error adding issue to project: ${ (error as Error).message }` };
    }
  }
}

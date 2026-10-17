import { createGitHubOctokit } from './octokit';
import { BaseTool, ToolResponse } from '../base';

/**
 * GitHub Update Issue Tool - Edit title, body, labels, assignees, or state.
 */
export class GitHubUpdateIssueWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { owner, repo, issue_number } = input;

    const octokit = await createGitHubOctokit(this.executionContext);

    try {
      const updateParams: any = { owner, repo, issue_number };
      if (input.title) updateParams.title = input.title;
      if (input.body !== undefined) updateParams.body = input.body;
      if (input.state) updateParams.state = input.state;
      if (Array.isArray(input.labels)) updateParams.labels = input.labels;
      if (Array.isArray(input.assignees)) updateParams.assignees = input.assignees;

      const response = await octokit.issues.update(updateParams);
      const issue = response.data;

      return {
        successBoolean: true,
        responseString: `Issue #${ issue.number } updated: "${ issue.title }"\nState: ${ issue.state }\nURL: ${ issue.html_url }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error updating issue: ${ (error as Error).message }`,
      };
    }
  }
}
